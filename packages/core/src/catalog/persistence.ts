import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type {
  ActionRecord,
  HttpTransport,
  InvocationRecord,
  ServerConfig,
  ServerState,
  TrustTier,
} from "../types.js";
import { TRUST_TIERS } from "../types.js";

/**
 * Bumped whenever the on-disk shape changes. A mismatch discards the entry
 * rather than attempting a migration — re-indexing is cheap relative to the
 * cost of reasoning about every historical format.
 */
export const CATALOG_CACHE_VERSION = 2;

/**
 * What gets written to disk.
 *
 * This is a superset of `HubSnapshot`: the Capability Manager canvas reads the
 * same file for diagnostics, so every field it depends on (`indexedAt`,
 * `servers`, `skills`, `context`, `history`) is preserved verbatim and the
 * cache-specific fields are additive.
 */
export interface PersistedCatalog {
  version: number;
  /** Hash of the server config the catalog was built from. */
  configHash: string;
  indexedAt: string;
  actions: ActionRecord[];
  servers: Record<string, ServerState>;
  skills: number;
  context: { actions: number; eagerTokensEstimate: number; hubTokensEstimate: number };
  history: InvocationRecord[];
}

/**
 * Resolves the cache location, honouring `XDG_CACHE_HOME` before falling back
 * to `~/.cache`. `ACTION_HUB_CACHE` overrides both and points at the file
 * itself, which is what the tests and the canvas use.
 */
export function defaultCatalogCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env["ACTION_HUB_CACHE"];
  if (explicit && explicit.length > 0) return explicit;

  const xdg = env["XDG_CACHE_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : resolve(homedir(), ".cache");
  return resolve(base, "action-hub", "catalog.json");
}

/**
 * Fingerprint of the parts of the server config that change what indexing
 * produces *and* are safe to persist.
 *
 * Env and header **keys** are hashed but their **values** are not, and OAuth
 * client secrets are excluded entirely. This is a deliberate trade-off, not a
 * claim that values are irrelevant: a rotated token should not throw away an
 * otherwise-valid catalog, and a secret must never end up in a digest that
 * lives on disk. The background re-index is what catches a value change that
 * actually altered the catalog. Server order is normalised away so reordering
 * the config file is not a cache-invalidating edit.
 */
export function hashServerConfigs(servers: readonly ServerConfig[]): string {
  const normalized = servers
    .map((server) => ({
      id: server.id,
      trust: server.trust ?? "untrusted",
      enabled: server.enabled !== false,
      allowTools: [...(server.allowTools ?? [])].sort(),
      denyTools: [...(server.denyTools ?? [])].sort(),
      transport: normalizeTransport(server.transport),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function normalizeTransport(transport: ServerConfig["transport"]): unknown {
  if (transport.type === "stdio") {
    return {
      type: "stdio",
      command: transport.command,
      args: transport.args ?? [],
      envKeys: Object.keys(transport.env ?? {}).sort(),
      cwd: transport.cwd ?? null,
    };
  }
  return {
    type: "http",
    url: transport.url,
    headerKeys: Object.keys(transport.headers ?? {}).sort(),
    auth: normalizeAuth(transport.auth),
  };
}

/**
 * Non-secret fingerprint of an OAuth block.
 *
 * Endpoints, grant, and scopes change what the connection *is*, so they belong
 * in the hash. `clientSecret` never appears — a digest lives on disk, and while
 * a hash is not reversible, a secret has no business being an input to a file
 * the user can copy into a bug report. Rotating a secret must not invalidate an
 * otherwise-valid catalog either, which is the same reasoning applied to header
 * and env values above.
 */
function normalizeAuth(auth: HttpTransport["auth"]): unknown {
  if (!auth) return null;
  return {
    grantType: auth.grantType ?? "authorization_code",
    tokenUrl: auth.tokenUrl,
    authorizationUrl: auth.authorizationUrl ?? null,
    clientId: auth.clientId,
    clientIdEnv: auth.clientIdEnv ?? null,
    clientSecretEnv: auth.clientSecretEnv ?? null,
    scopes: [...(auth.scopes ?? [])].sort(),
    resource: auth.resource ?? null,
    audience: auth.audience ?? null,
  };
}

export interface CatalogCacheOptions {
  path?: string;
  env?: NodeJS.ProcessEnv;
  /** Receives a one-line reason whenever a read or write is abandoned. */
  onWarning?: (message: string) => void;
}

/**
 * Durable catalog store.
 *
 * Every method is failure-tolerant on purpose. A cache is an optimisation; an
 * unreadable, corrupt, or unwritable file must degrade into a full index and
 * never into a crash, because the hub is a hard dependency of the agent
 * session that spawned it.
 */
export class CatalogCache {
  readonly path: string;
  readonly #warn: (message: string) => void;
  /**
   * Serialises writes on this instance. Each `write` chains onto the previous
   * one so two concurrent callers never race the shared destination path: the
   * last write enqueued wins deterministically, and no rename/unlink from one
   * write can interleave with another. Rejections are swallowed here so a single
   * failed write does not poison every write that follows it.
   */
  #writeChain: Promise<unknown> = Promise.resolve();

  constructor(options: CatalogCacheOptions = {}) {
    this.path = options.path ?? defaultCatalogCachePath(options.env);
    this.#warn = options.onWarning ?? (() => {});
  }

  /** Parses the file without validating freshness. Returns undefined on any problem. */
  async read(): Promise<PersistedCatalog | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (cause) {
      if (!isNotFound(cause)) {
        this.#warn(`could not read catalog cache at ${this.path}: ${message(cause)}`);
      }
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.#warn(`catalog cache at ${this.path} is not valid JSON; ignoring it`);
      return undefined;
    }

    const entry = coerceEntry(parsed);
    if (!entry) {
      this.#warn(`catalog cache at ${this.path} has an unrecognised shape; ignoring it`);
      return undefined;
    }
    return entry;
  }

  /**
   * Returns the entry only when it is safe to reuse: matching schema version
   * and matching config fingerprint.
   */
  async load(configHash: string): Promise<PersistedCatalog | undefined> {
    const entry = await this.read();
    if (!entry) return undefined;

    if (entry.version !== CATALOG_CACHE_VERSION) {
      this.#warn(
        `catalog cache at ${this.path} is version ${entry.version}, expected ${CATALOG_CACHE_VERSION}; re-indexing`,
      );
      return undefined;
    }
    if (entry.configHash !== configHash) {
      this.#warn("server configuration changed since the catalog was cached; re-indexing");
      return undefined;
    }
    return entry;
  }

  /**
   * Atomic, serialised write.
   *
   * The canvas polls this path on a timer and must never observe a half-written
   * file, so the payload is written to a temp file and renamed into place —
   * rename is atomic on a single filesystem. Two things make it safe under the
   * concurrency the host actually produces (an unawaited write after every
   * `execute`, plus the background refresh):
   *
   *  1. Each write uses a **unique** temp path (`randomUUID`), so two writes
   *     racing in the same process can never share a temp file and interleave
   *     their bytes, and cleanup only ever removes *this* write's temp.
   *  2. Writes are **serialised** on a per-instance promise chain, so the
   *     rename/unlink of one write cannot interleave with another and the last
   *     write enqueued is the last to land on disk.
   */
  write(entry: PersistedCatalog): Promise<boolean> {
    const run = this.#writeChain.then(() => this.#writeNow(entry));
    // Keep the chain alive regardless of this write's outcome.
    this.#writeChain = run.catch(() => undefined);
    return run;
  }

  async #writeNow(entry: PersistedCatalog): Promise<boolean> {
    const dir = dirname(this.path);
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(temp, JSON.stringify(entry, null, 2), { encoding: "utf8", mode: 0o600 });
      await rename(temp, this.path);
      return true;
    } catch (cause) {
      this.#warn(`could not write catalog cache to ${this.path}: ${message(cause)}`);
      await unlink(temp).catch(() => {});
      return false;
    }
  }
}

function coerceEntry(value: unknown): PersistedCatalog | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value["version"] !== "number") return undefined;
  if (typeof value["configHash"] !== "string") return undefined;
  if (!Array.isArray(value["actions"])) return undefined;

  const actions: ActionRecord[] = [];
  for (const candidate of value["actions"]) {
    const record = coerceAction(candidate);
    if (record) actions.push(record);
  }

  return {
    version: value["version"],
    configHash: value["configHash"],
    indexedAt: typeof value["indexedAt"] === "string" ? value["indexedAt"] : new Date(0).toISOString(),
    actions,
    servers: isRecord(value["servers"]) ? (value["servers"] as Record<string, ServerState>) : {},
    skills: typeof value["skills"] === "number" ? value["skills"] : 0,
    context: isRecord(value["context"])
      ? (value["context"] as PersistedCatalog["context"])
      : { actions: actions.length, eagerTokensEstimate: 0, hubTokensEstimate: 0 },
    history: Array.isArray(value["history"]) ? (value["history"] as InvocationRecord[]) : [],
  };
}

/**
 * Individual malformed records are dropped rather than invalidating the whole
 * file. A truncated or hand-edited cache should still yield whatever entries
 * survive; the background re-index repairs the rest.
 */
function coerceAction(value: unknown): ActionRecord | undefined {
  if (!isRecord(value)) return undefined;
  const id = value["id"];
  const serverId = value["serverId"];
  const name = value["name"];
  const kind = value["kind"];
  const trust = value["trust"];

  if (typeof id !== "string" || id.length === 0) return undefined;
  if (typeof serverId !== "string" || serverId.length === 0) return undefined;
  if (typeof name !== "string" || name.length === 0) return undefined;
  if (kind !== "tool" && kind !== "skill") return undefined;
  if (!isTrust(trust)) return undefined;

  return {
    id,
    kind,
    serverId,
    name,
    summary: typeof value["summary"] === "string" ? value["summary"] : name,
    description: typeof value["description"] === "string" ? value["description"] : undefined,
    inputSchema: isRecord(value["inputSchema"]) ? value["inputSchema"] : {},
    tags: Array.isArray(value["tags"])
      ? value["tags"].filter((tag): tag is string => typeof tag === "string")
      : undefined,
    trust,
    readOnly: value["readOnly"] === true ? true : undefined,
  };
}

function isTrust(value: unknown): value is TrustTier {
  return typeof value === "string" && (TRUST_TIERS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(cause: unknown): boolean {
  return isRecord(cause) && cause["code"] === "ENOENT";
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
