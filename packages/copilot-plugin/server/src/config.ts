import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { ServerConfig, TrustTier } from "@action-hub/core";

export interface HubConfigFile {
  servers?: unknown;
  autoApproveAtOrAbove?: unknown;
  approvalTtlSeconds?: unknown;
}

export interface HubConfig {
  servers: ServerConfig[];
  autoApproveAtOrAbove: TrustTier;
  /** Lifetime of an approval token, in milliseconds. */
  approvalTtlMs: number;
}

const DEFAULT_APPROVAL_TTL_SECONDS = 300;
const MAX_APPROVAL_TTL_SECONDS = 3600;
const mutationChains = new Map<string, Promise<void>>();

const VALID_TRUST: readonly string[] = ["blocked", "untrusted", "trusted"];

export function defaultConfigPath(): string {
  const fromEnv = process.env["ACTION_HUB_CONFIG"];
  if (fromEnv && fromEnv.length > 0) return expandHome(fromEnv);
  return resolve(homedir(), ".config", "action-hub", "servers.json");
}

/**
 * Reads the downstream server list.
 *
 * A missing file is not an error: a freshly installed plugin has nothing
 * configured yet, and the hub should still start so the capability manager can
 * be opened to add servers.
 */
export async function loadConfig(path: string): Promise<HubConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    if (isNotFound(cause)) {
      return {
        servers: [],
        autoApproveAtOrAbove: "trusted",
        approvalTtlMs: DEFAULT_APPROVAL_TTL_SECONDS * 1000,
      };
    }
    throw new Error(`Failed to read Action Hub config at ${path}: ${message(cause)}`);
  }

  let parsed: HubConfigFile;
  try {
    parsed = JSON.parse(raw) as HubConfigFile;
  } catch (cause) {
    throw new Error(`Action Hub config at ${path} is not valid JSON: ${message(cause)}`);
  }

  return {
    servers: parseServers(parsed.servers, `Action Hub config at ${path}`),
    autoApproveAtOrAbove: isTrust(parsed.autoApproveAtOrAbove)
      ? parsed.autoApproveAtOrAbove
      : "trusted",
    approvalTtlMs: parseApprovalTtl(parsed.approvalTtlSeconds),
  };
}

/** Clamped rather than rejected: a nonsensical TTL should not stop the hub booting. */
function parseApprovalTtl(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_APPROVAL_TTL_SECONDS * 1000;
  }
  return Math.min(Math.round(value), MAX_APPROVAL_TTL_SECONDS) * 1000;
}

/**
 * Validates a single server entry that did not come from the config file —
 * notably one supplied by the capability manager canvas.
 *
 * The canvas is untrusted input, so a candidate entry goes through exactly the
 * same parser the on-disk config does before it is registered or persisted.
 */
export function parseServerEntry(entry: unknown, label = "server"): ServerConfig {
  const parsed = parseServers([entry], label);
  const config = parsed[0];
  if (!config) throw new Error(`${label}: a server entry is required`);
  return config;
}

/**
 * Reads the config file without normalizing or expanding anything.
 *
 * Mutations are applied to this raw form so that `${ENV_VAR}` references and
 * any keys this version does not understand survive a write-back instead of
 * being replaced by their expanded values.
 */
export async function readRawConfig(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    if (isNotFound(cause)) return {};
    throw new Error(`Failed to read Action Hub config at ${path}: ${message(cause)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Action Hub config at ${path} is not valid JSON: ${message(cause)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`Action Hub config at ${path} must contain a JSON object`);
  }
  return parsed;
}

/** Reads the `servers` array out of a raw config document. */
export function rawServers(config: Record<string, unknown>): Record<string, unknown>[] {
  const value = config["servers"];
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

/**
 * Persists a raw config document atomically, matching the snapshot writer, so
 * a concurrently reading canvas can never observe a half-written file.
 */
export async function writeRawConfig(
  path: string,
  config: Record<string, unknown>,
): Promise<void> {
  await enqueueMutation(path, () => writeRawConfigFile(path, config));
}

export async function mutateRawConfig(
  path: string,
  mutate: (config: Record<string, unknown>) => void,
): Promise<void> {
  await enqueueMutation(path, async () => {
    const config = await readRawConfig(path);
    mutate(config);
    await writeRawConfigFile(path, config);
  });
}

async function enqueueMutation(path: string, mutation: () => Promise<void>): Promise<void> {
  const previous = mutationChains.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(mutation);
  mutationChains.set(path, current);
  try {
    await current;
  } finally {
    if (mutationChains.get(path) === current) mutationChains.delete(path);
  }
}

async function writeRawConfigFile(
  path: string,
  config: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const mode = await stat(path).then((entry) => entry.mode & 0o777).catch(() => 0o600);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode });
  await rename(temp, path);
}

function parseServers(value: unknown, label: string): ServerConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${label}: "servers" must be an array`);
  }

  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`${label}: servers[${index}] must be an object`);
    }
    const id = entry["id"];
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`${label}: servers[${index}].id must be a non-empty string`);
    }
    if (seen.has(id)) {
      throw new Error(`${label}: duplicate server id "${id}"`);
    }
    seen.add(id);

    const transport = parseTransport(entry["transport"], `servers[${index}]`, label);
    const trust = entry["trust"];

    return {
      id,
      displayName: typeof entry["displayName"] === "string" ? entry["displayName"] : undefined,
      transport,
      trust: isTrust(trust) ? trust : "untrusted",
      enabled: entry["enabled"] === undefined ? true : entry["enabled"] !== false,
      allowTools: parseStringArray(entry["allowTools"]),
      denyTools: parseStringArray(entry["denyTools"]),
    } satisfies ServerConfig;
  });
}

function parseTransport(value: unknown, where: string, label: string): ServerConfig["transport"] {
  if (!isRecord(value)) {
    throw new Error(`${label}: ${where}.transport is required`);
  }
  const type = value["type"];

  if (type === "stdio") {
    const command = value["command"];
    if (typeof command !== "string" || command.length === 0) {
      throw new Error(`${label}: ${where}.transport.command is required for stdio`);
    }
    return {
      type: "stdio",
      command,
      args: parseStringArray(value["args"]) ?? [],
      env: isRecord(value["env"]) ? stringMap(value["env"]) : undefined,
      cwd: typeof value["cwd"] === "string" ? expandHome(value["cwd"]) : undefined,
    };
  }

  if (type === "http") {
    const url = value["url"];
    if (typeof url !== "string" || url.length === 0) {
      throw new Error(`${label}: ${where}.transport.url is required for http`);
    }
    return {
      type: "http",
      url,
      headers: isRecord(value["headers"]) ? stringMap(value["headers"]) : undefined,
    };
  }

  throw new Error(`${label}: ${where}.transport.type must be "stdio" or "http"`);
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function stringMap(value: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = expandEnv(entry);
  }
  return out;
}

/** Lets a config reference secrets without embedding them in the file. */
function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
    return process.env[name] ?? match;
  });
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return expandEnv(value);
}

export function isTrust(value: unknown): value is TrustTier {
  return typeof value === "string" && VALID_TRUST.includes(value);
}

export const TRUST_TIERS: readonly string[] = VALID_TRUST;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(cause: unknown): boolean {
  return isRecord(cause) && cause["code"] === "ENOENT";
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
