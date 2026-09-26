import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  CatalogCache,
  discoverAll,
  executeMigration,
  hashServerConfigs,
  type ActionHub,
  type TrustTier,
} from "@action-hub/core";
import {
  TRUST_TIERS,
  isTrust,
  parseServerEntry,
  rawServers,
  mutateRawConfig,
  readRawConfig,
} from "./config.js";
import { writeSnapshot } from "./snapshot.js";

/** Rejects oversized bodies before buffering them; every operation is tiny. */
const MAX_BODY_BYTES = 64 * 1024;
const SEARCH_LIMIT_MAX = 50;

export interface ControlServer {
  url: string;
  token: string;
  close(): Promise<void>;
}

export function defaultControlPath(): string {
  const explicit = process.env["ACTION_HUB_CONTROL"];
  if (explicit) return explicit;
  const base = process.env["XDG_CACHE_HOME"] || resolve(homedir(), ".cache");
  return resolve(base, "action-hub", "control.json");
}

/**
 * A localhost-only write path from the Capability Manager canvas back into the
 * running hub.
 *
 * The canvas must never edit `servers.json` itself: the hub owns connection
 * state, the catalog, and trust, and a file edited behind its back would be
 * silently ignored until the next restart. Instead the canvas calls these
 * operations, which validate the request, mutate the live hub, persist the
 * config, and refresh the snapshot — so on-disk and in-memory state can never
 * drift apart.
 *
 * Access is guarded two ways: the listener binds to 127.0.0.1 only, and every
 * request must present a bearer token generated fresh for this process. The
 * token is published to a file readable only by the current user, which is how
 * the canvas discovers the endpoint at all.
 */
export async function startControlServer(
  hub: ActionHub,
  configPath: string,
  controlPath = defaultControlPath(),
): Promise<ControlServer> {
  const token = randomBytes(32).toString("hex");
  const cache = new CatalogCache();

  const http = createServer((req, res) => {
    handle(hub, configPath, token, cache, req, res).catch((cause: unknown) => {
      respond(res, 500, { ok: false, error: message(cause) });
    });
  });

  await new Promise<void>((done, fail) => {
    http.once("error", fail);
    http.listen(0, "127.0.0.1", () => {
      http.removeListener("error", fail);
      done();
    });
  });

  const address = http.address();
  if (address === null || typeof address === "string") {
    await closeHttp(http);
    throw new Error("Control server did not bind to a TCP port");
  }

  const url = `http://127.0.0.1:${address.port}`;
  await publish(controlPath, { url, token, pid: process.pid, configPath });

  return {
    url,
    token,
    close: async () => {
      await closeHttp(http);
      // Leaving a stale endpoint behind would make the canvas retry a dead
      // port on every poll instead of degrading to its read-only view.
      await rm(controlPath, { force: true }).catch(() => undefined);
    },
  };
}

async function handle(
  hub: ActionHub,
  configPath: string,
  token: string,
  cache: CatalogCache,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!authorized(req, token)) {
    respond(res, 401, { ok: false, error: "Unauthorized" });
    return;
  }

  const path = (req.url ?? "/").split("?")[0];

  if (req.method === "GET" && path === "/state") {
    respond(res, 200, { ok: true, state: liveState(hub, configPath) });
    return;
  }

  if (req.method !== "POST") {
    respond(res, 405, { ok: false, error: `Unsupported method ${req.method ?? "?"}` });
    return;
  }

  if (req.headers["content-type"] !== "application/json") {
    respond(res, 415, { ok: false, error: "Content-Type must be application/json" });
    return;
  }

  let input: Record<string, unknown>;
  try {
    input = await readBody(req);
  } catch (cause) {
    respond(res, 400, { ok: false, error: message(cause) });
    return;
  }

  try {
    switch (path) {
      case "/set-enabled":
        respond(res, 200, await setEnabled(hub, configPath, cache, input));
        return;
      case "/set-trust":
        respond(res, 200, await setTrust(hub, configPath, cache, input));
        return;
      case "/search":
        respond(res, 200, await search(hub, input));
        return;
      case "/add-server":
        respond(res, 200, await addServer(hub, configPath, cache, input));
        return;
      case "/reconnect":
        respond(res, 200, await reconnect(hub, cache, input));
        return;
      case "/check-health":
        respond(res, 200, await checkHealth(hub, cache, input));
        return;
      case "/import-config":
        respond(res, 200, await importConfig(hub, configPath, cache, input));
        return;
      case "/migrate":
        respond(res, 200, await migrateCapabilities(hub, configPath, cache, input));
        return;
      case "/load-action":
        respond(res, 200, await loadAction(hub, input));
        return;
      case "/load-bundle":
        respond(res, 200, await loadBundle(hub, input));
        return;
      default:
        respond(res, 404, { ok: false, error: `Unknown control operation "${path}"` });
        return;
    }
  } catch (cause) {
    // Validation failures are the expected case here, so they are reported as
    // a clean result the canvas can show inline rather than as a transport
    // error that would look like the hub had gone away.
    respond(res, 400, { ok: false, error: message(cause) });
  }
}

async function setEnabled(
  hub: ActionHub,
  configPath: string,
  cache: CatalogCache,
  input: Record<string, unknown>,
): Promise<unknown> {
  const serverId = requireKnownServer(hub, input["serverId"]);
  const enabled = requireBoolean(input["enabled"], "enabled");

  hub.connections.setEnabled(serverId, enabled);
  await persist(configPath, serverId, { enabled });

  let indexed = 0;
  if (enabled) {
    const result = await hub.indexServer(serverId);
    indexed = result.indexed;
    if (result.error) {
      await refreshSnapshot(hub, cache);
      return { ok: true, serverId, enabled, indexed, warning: result.error };
    }
  } else {
    // A disabled server keeps no catalog entries, otherwise search would keep
    // offering actions that can no longer be executed.
    hub.catalog.removeServer(serverId);
    hub.connections.recordToolCount(serverId, 0);
  }

  await refreshSnapshot(hub, cache);
  return { ok: true, serverId, enabled, indexed };
}

async function setTrust(
  hub: ActionHub,
  configPath: string,
  cache: CatalogCache,
  input: Record<string, unknown>,
): Promise<unknown> {
  const serverId = requireKnownServer(hub, input["serverId"]);
  const trust = input["trust"];
  if (!isTrust(trust)) {
    throw new Error(`"trust" must be one of ${TRUST_TIERS.join(", ")}`);
  }

  hub.connections.setTrust(serverId, trust);
  retagCatalog(hub, serverId, trust);
  await persist(configPath, serverId, { trust });
  await refreshSnapshot(hub, cache);

  return { ok: true, serverId, trust, retagged: hub.catalog.countByServer(serverId) };
}

async function reconnect(
  hub: ActionHub,
  cache: CatalogCache,
  input: Record<string, unknown>,
): Promise<unknown> {
  const serverId = requireKnownServer(hub, input["serverId"]);
  const health = await hub.reconnect(serverId);
  await refreshSnapshot(hub, cache);
  return { ok: true, serverId, health };
}

async function checkHealth(
  hub: ActionHub,
  cache: CatalogCache,
  input: Record<string, unknown>,
): Promise<unknown> {
  const serverId = input["serverId"];
  if (typeof serverId === "string" && serverId.length > 0) {
    const health = await hub.checkHealth(serverId);
    await refreshSnapshot(hub, cache);
    return { ok: true, serverId, health };
  }
  const results = await hub.checkAllHealth();
  await refreshSnapshot(hub, cache);
  return { ok: true, results };
}

async function loadAction(hub: ActionHub, input: Record<string, unknown>): Promise<unknown> {
  const actionId = input["actionId"];
  if (typeof actionId !== "string" || !actionId) {
    throw new Error(`"actionId" must be a non-empty string`);
  }
  const action = hub.load(actionId);
  return {
    ok: true,
    action: {
      id: action.id,
      name: action.name,
      serverId: action.serverId,
      kind: action.kind,
      trust: action.trust,
      summary: action.summary,
      description: action.description ?? action.summary,
      inputSchema: action.inputSchema,
    },
  };
}

async function loadBundle(hub: ActionHub, input: Record<string, unknown>): Promise<unknown> {
  const bundleId = input["bundleId"];
  if (typeof bundleId !== "string" || !bundleId) {
    throw new Error(`"bundleId" must be a non-empty string`);
  }
  const loaded = hub.loadBundle(bundleId);
  return {
    ok: true,
    bundle: {
      id: loaded.id,
      displayName: loaded.displayName,
      description: loaded.description,
      tokensSaved: loaded.tokensSaved,
      actions: loaded.actions.map((act) => ({
        id: act.id,
        name: act.name,
        serverId: act.serverId,
        trust: act.trust,
        summary: act.summary,
        inputSchema: act.inputSchema,
      })),
    },
  };
}

async function importConfig(
  hub: ActionHub,
  configPath: string,
  cache: CatalogCache,
  input: Record<string, unknown>,
): Promise<unknown> {
  const rawConfig = input["config"];
  if (!rawConfig || typeof rawConfig !== "object") {
    throw new Error(`"config" must be a JSON object containing MCP servers`);
  }

  const record = rawConfig as Record<string, unknown>;
  const serversMap = record["mcpServers"] || record["servers"];
  const added: string[] = [];
  const errors: string[] = [];

  if (serversMap && typeof serversMap === "object" && !Array.isArray(serversMap)) {
    // Claude Desktop / VS Code / Cursor style: { "mcpServers": { "github": { "command": "...", "args": [...] } } }
    for (const [id, value] of Object.entries(serversMap as Record<string, unknown>)) {
      try {
        if (!value || typeof value !== "object") continue;
        const entry = value as Record<string, unknown>;
        const transport: Record<string, unknown> = entry["url"]
          ? { type: "http", url: entry["url"], headers: entry["headers"] }
          : {
              type: "stdio",
              command: entry["command"],
              args: Array.isArray(entry["args"]) ? entry["args"] : [],
              env: entry["env"],
            };

        const serverPayload = {
          id,
          displayName: typeof entry["displayName"] === "string" ? entry["displayName"] : id,
          trust: "untrusted" as TrustTier,
          enabled: entry["enabled"] !== false,
          transport,
        };

        if (hub.connections.getConfig(id)) {
          errors.push(`Server "${id}" already exists`);
          continue;
        }

        const config = parseServerEntry(serverPayload, "import_config");
        await mutateRawConfig(configPath, (raw) => {
          const servers = rawServers(raw);
          if (!servers.some((s) => s["id"] === config.id)) {
            servers.push(serverPayload);
            raw["servers"] = servers;
          }
        });
        hub.connections.register(config);
        if (config.enabled !== false) {
          await hub.indexServer(config.id);
        }
        added.push(id);
      } catch (err) {
        errors.push(`Failed to import "${id}": ${message(err)}`);
      }
    }
  } else if (Array.isArray(serversMap)) {
    // Array style: { "servers": [ { "id": "...", ... } ] }
    for (const item of serversMap) {
      try {
        if (!item || typeof item !== "object") continue;
        const entry = item as Record<string, unknown>;
        const id = String(entry["id"] || "");
        if (!id) continue;
        if (hub.connections.getConfig(id)) {
          errors.push(`Server "${id}" already exists`);
          continue;
        }
        const config = parseServerEntry(entry, "import_config");
        await mutateRawConfig(configPath, (raw) => {
          const servers = rawServers(raw);
          if (!servers.some((s) => s["id"] === config.id)) {
            servers.push(entry);
            raw["servers"] = servers;
          }
        });
        hub.connections.register(config);
        if (config.enabled !== false) {
          await hub.indexServer(config.id);
        }
        added.push(id);
      } catch (err) {
        errors.push(`Failed to import "${item}": ${message(err)}`);
      }
    }
  } else {
    throw new Error(`No "mcpServers" or "servers" found in provided configuration.`);
  }

  await refreshSnapshot(hub, cache);
  return { ok: true, imported: added, count: added.length, errors: errors.length > 0 ? errors : undefined };
}

async function migrateCapabilities(
  hub: ActionHub,
  configPath: string,
  cache: CatalogCache,
  input: Record<string, unknown>,
): Promise<unknown> {
  const write = input["write"] !== false;
  const overwrite = input["overwrite"] === true;
  const customPaths = Array.isArray(input["customPaths"])
    ? input["customPaths"].filter((p): p is string => typeof p === "string")
    : undefined;
  const skipDefaults = Boolean(input["skipDefaults"]);

  const discovered = await discoverAll({ customPaths, skipDefaults });
  const raw = await readRawConfig(configPath);
  const existingServers = hub.connections.configs();
  const existingSkills = Array.isArray(raw["skills"]) ? (raw["skills"] as any) : [];
  const existingBundles = hub.bundles.list();

  const migration = executeMigration({
    existingServers,
    existingSkills,
    existingBundles,
    discovered,
    options: { overwrite },
  });

  if (write) {
    await mutateRawConfig(configPath, (target) => {
      // Preserve raw entries so unexpanded ${ENV_VAR} secrets and custom fields remain intact
      const existingRaw = rawServers(target);
      const serverEntries = [...existingRaw];

      for (const toAdd of migration.plan.serversToAdd) {
        if (!serverEntries.some((s) => s["id"] === toAdd.id)) {
          serverEntries.push({ ...toAdd });
        }
      }

      for (const toUpdate of migration.plan.serversToUpdate) {
        const idx = serverEntries.findIndex((s) => s["id"] === toUpdate.id);
        if (idx !== -1) {
          serverEntries[idx] = { ...serverEntries[idx], ...toUpdate };
        } else {
          serverEntries.push({ ...toUpdate });
        }
      }

      target["servers"] = serverEntries;
      target["skills"] = migration.mergedSkills;
      target["bundles"] = migration.mergedBundles;
    });

    // Hot-register newly added and updated servers into live hub
    const serversToProcess = [
      ...migration.plan.serversToAdd,
      ...migration.plan.serversToUpdate,
    ];
    for (const server of serversToProcess) {
      hub.connections.register(server);
      if (server.enabled !== false) {
        void hub.indexServer(server.id);
      } else {
        hub.catalog.removeServer(server.id);
        hub.connections.recordToolCount(server.id, 0);
      }
    }

    // Hot-register newly added and updated skills into live catalog
    const skillsToProcess = [
      ...migration.plan.skillsToAdd,
      ...migration.plan.skillsToUpdate,
    ];
    if (skillsToProcess.length > 0) {
      hub.registerSkills(
        skillsToProcess.map((s) => ({
          id: s.id,
          name: s.name,
          serverId: s.sourceClient ?? "skills",
          summary: s.summary,
          description: s.description,
          tags: s.tags,
          trust: s.trust ?? "trusted",
        })),
      );
    }

    // Hot-register newly added bundles into live registry
    for (const bundle of migration.plan.bundlesToAdd) {
      hub.bundles.add(bundle);
    }

    await refreshSnapshot(hub, cache);
  }

  return {
    ok: true,
    write,
    plan: migration.plan,
  };
}

async function search(hub: ActionHub, input: Record<string, unknown>): Promise<unknown> {
  const query = input["query"];
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error(`"query" must be a non-empty string`);
  }

  const serverId = input["serverId"];
  if (serverId !== undefined && typeof serverId !== "string") {
    throw new Error(`"serverId" must be a string`);
  }

  const limit = parseLimit(input["limit"]);
  const includeSchema = input["includeSchema"] === true;
  const hits = await hub.search(query, {
    limit,
    serverIds: serverId ? [serverId] : undefined,
    includeSchema,
  });

  const matchingBundles = hub.searchBundles(query);

  return {
    ok: true,
    query,
    count: hits.length,
    results: hits.map((hit) => ({
      id: hit.id,
      name: hit.name,
      serverId: hit.serverId,
      kind: hit.kind,
      summary: hit.summary,
      score: Math.round(hit.score * 1000) / 1000,
      inputSchema: hit.inputSchema,
    })),
    bundles: matchingBundles.map((b) => ({
      id: b.id,
      displayName: b.displayName,
      description: b.description,
      actionIds: b.actionIds,
      serverIds: b.serverIds,
    })),
  };
}

async function addServer(
  hub: ActionHub,
  configPath: string,
  cache: CatalogCache,
  input: Record<string, unknown>,
): Promise<unknown> {
  const config = parseServerEntry(input["server"], "add_server");

  if (hub.connections.getConfig(config.id)) {
    throw new Error(`Server "${config.id}" already exists`);
  }

  await mutateRawConfig(configPath, (raw) => {
    const servers = rawServers(raw);
    if (servers.some((entry) => entry["id"] === config.id)) {
      throw new Error(`Server "${config.id}" already exists in ${configPath}`);
    }
    // Persist the caller's entry rather than the parsed one so `${ENV_VAR}`
    // references stay unexpanded and secrets are never written to disk.
    servers.push(asRecord(input["server"]));
    raw["servers"] = servers;
  });
  hub.connections.register(config);

  const result = config.enabled === false ? { indexed: 0 } : await hub.indexServer(config.id);
  await refreshSnapshot(hub, cache);

  return {
    ok: true,
    serverId: config.id,
    indexed: result.indexed,
    warning: "error" in result ? result.error : undefined,
  };
}

/**
 * Rewrites one server entry in the config file.
 *
 * The document is re-read, patched, and written back rather than regenerated
 * from the hub's in-memory configs, so comments-adjacent fields this version
 * does not model — and unexpanded env references — survive the round trip.
 */
async function persist(
  configPath: string,
  serverId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await mutateRawConfig(configPath, (raw) => {
    const servers = rawServers(raw);
    const entry = servers.find((candidate) => candidate["id"] === serverId);
    if (!entry) {
      throw new Error(`Server "${serverId}" is not present in ${configPath}`);
    }
    Object.assign(entry, patch);
    raw["servers"] = servers;
  });
}

/**
 * Catalog records copy their server's trust at index time, so a retier has to
 * be pushed into the existing records. Re-adding them is cheaper than a full
 * reindex and, unlike a reindex, cannot fail because a server is unreachable.
 */
function retagCatalog(hub: ActionHub, serverId: string, trust: TrustTier): void {
  const records = hub.catalog.listByServer(serverId);
  hub.catalog.addAll(records.map((record) => ({ ...record, trust })));
}

function liveState(hub: ActionHub, configPath: string): unknown {
  const snapshot = hub.snapshot();
  const configs = new Map(hub.connections.configs().map((config) => [config.id, config]));

  const servers = hub.serverStates().map((state) => {
    const config = configs.get(state.id);
    return {
      id: state.id,
      displayName: state.displayName,
      transport: config?.transport.type ?? "unknown",
      trust: state.trust,
      enabled: config?.enabled !== false,
      status: state.status,
      toolCount: state.toolCount,
      error: state.error,
      lastActivatedAt: state.lastActivatedAt,
      latencyMs: state.latencyMs,
      circuitBreaker: state.circuitOpen,
      lastHealthCheck: state.lastActivatedAt,
    };
  });

  const catalogRecords = hub.catalog.all();
  const actionsList = catalogRecords.map((r) => ({
    id: r.id,
    name: r.name,
    serverId: r.serverId,
    kind: r.kind,
    trust: r.trust,
    summary: r.summary,
    description: r.description ?? r.summary,
    inputSchema: r.inputSchema,
    tags: r.tags,
  }));

  const bundles = hub.bundles.list().map((b) => ({
    id: b.id,
    displayName: b.displayName,
    description: b.description,
    actionIds: b.actionIds,
    serverIds: b.serverIds,
  }));

  return {
    configPath,
    servers,
    actions: snapshot.context.actions,
    skills: snapshot.skills,
    history: snapshot.history.slice(-50).reverse(),
    context: snapshot.context,
    indexedAt: snapshot.indexedAt,
    bundles,
    actionsList,
  };
}

async function refreshSnapshot(hub: ActionHub, cache: CatalogCache): Promise<void> {
  const configHash = hashServerConfigs(hub.connections.configs());
  await writeSnapshot(hub, configHash, cache);
}

function requireKnownServer(hub: ActionHub, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`"serverId" must be a non-empty string`);
  }
  if (!hub.connections.getConfig(value)) {
    throw new Error(`Unknown server "${value}"`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`"${field}" must be a boolean`);
  return value;
}

function parseLimit(value: unknown): number {
  if (value === undefined) return 10;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`"limit" must be an integer`);
  }
  if (value < 1 || value > SEARCH_LIMIT_MAX) {
    throw new Error(`"limit" must be between 1 and ${SEARCH_LIMIT_MAX}`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers["authorization"];
  return typeof header === "string" && header === `Bearer ${token}`;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(buffer);
  }

  if (size === 0) return {};

  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function respond(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function publish(path: string, payload: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // 0600: the token in this file is the only credential guarding the endpoint.
    await writeFile(temp, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temp, path);
  } catch (cause) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw cause;
  }
}

async function closeHttp(http: Server): Promise<void> {
  await new Promise<void>((done) => http.close(() => done()));
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
