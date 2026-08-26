import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ServerConfig, TrustTier } from "@action-hub/core";

export interface HubConfigFile {
  servers?: unknown;
  autoApproveAtOrAbove?: unknown;
}

export interface HubConfig {
  servers: ServerConfig[];
  autoApproveAtOrAbove: TrustTier;
}

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
    if (isNotFound(cause)) return { servers: [], autoApproveAtOrAbove: "trusted" };
    throw new Error(`Failed to read Action Hub config at ${path}: ${message(cause)}`);
  }

  let parsed: HubConfigFile;
  try {
    parsed = JSON.parse(raw) as HubConfigFile;
  } catch (cause) {
    throw new Error(`Action Hub config at ${path} is not valid JSON: ${message(cause)}`);
  }

  return {
    servers: parseServers(parsed.servers, path),
    autoApproveAtOrAbove: isTrust(parsed.autoApproveAtOrAbove)
      ? parsed.autoApproveAtOrAbove
      : "trusted",
  };
}

function parseServers(value: unknown, path: string): ServerConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Action Hub config at ${path}: "servers" must be an array`);
  }

  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Action Hub config at ${path}: servers[${index}] must be an object`);
    }
    const id = entry["id"];
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`Action Hub config at ${path}: servers[${index}].id must be a non-empty string`);
    }
    if (seen.has(id)) {
      throw new Error(`Action Hub config at ${path}: duplicate server id "${id}"`);
    }
    seen.add(id);

    const transport = parseTransport(entry["transport"], `servers[${index}]`, path);
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

function parseTransport(value: unknown, where: string, path: string): ServerConfig["transport"] {
  if (!isRecord(value)) {
    throw new Error(`Action Hub config at ${path}: ${where}.transport is required`);
  }
  const type = value["type"];

  if (type === "stdio") {
    const command = value["command"];
    if (typeof command !== "string" || command.length === 0) {
      throw new Error(`Action Hub config at ${path}: ${where}.transport.command is required for stdio`);
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
      throw new Error(`Action Hub config at ${path}: ${where}.transport.url is required for http`);
    }
    return {
      type: "http",
      url,
      headers: isRecord(value["headers"]) ? stringMap(value["headers"]) : undefined,
    };
  }

  throw new Error(
    `Action Hub config at ${path}: ${where}.transport.type must be "stdio" or "http"`,
  );
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

function isTrust(value: unknown): value is TrustTier {
  return typeof value === "string" && VALID_TRUST.includes(value);
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
