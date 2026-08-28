import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { hubState } from "./hub.mjs";

function configPath() {
  const fromEnv = process.env.ACTION_HUB_CONFIG;
  if (fromEnv) return fromEnv;
  return resolve(homedir(), ".config", "action-hub", "servers.json");
}

/**
 * Mirrors core's XDG resolution so the canvas reads the same cache file the hub
 * writes. This file belongs to core; the canvas only ever reads it. Every write
 * the canvas performs goes through the hub's control endpoint instead, because
 * writing here would corrupt the catalog rather than merely a display snapshot.
 */
function cachePath() {
  const fromEnv = process.env.ACTION_HUB_CACHE;
  if (fromEnv) return fromEnv;
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg ? xdg : resolve(homedir(), ".cache");
  return resolve(base, "action-hub", "catalog.json");
}

/**
 * Reads the live hub when it is running, and the config plus catalog snapshot
 * on disk when it is not.
 *
 * The live path matters because a toggle applied through the control endpoint
 * takes effect in memory immediately, while the snapshot on disk is only a
 * point-in-time copy. The file path matters because the canvas must still show
 * something useful when no hub is running — it just cannot offer controls.
 *
 * It deliberately never connects to downstream servers itself; the hub owns
 * every connection.
 */
export async function readState() {
  const live = await hubState();
  if (live) return { ...live, hubAvailable: true };

  const fallback = await readFileState();
  return { ...fallback, hubAvailable: false };
}

/**
 * Every field is treated as absent until proven well-formed.
 *
 * The cache file is written by another process and may be observed missing,
 * empty, half-written, or in a newer schema than this canvas understands. None
 * of those are error states worth showing the user — the config file alone is
 * enough to render a useful server list, so anything unreadable degrades to
 * "not indexed yet" rather than a broken panel.
 */
async function readFileState() {
  const [config, cache] = await Promise.all([readJson(configPath()), readJson(cachePath())]);

  const configured = Array.isArray(config?.servers) ? config.servers : [];
  const indexed = isRecord(cache?.servers) ? cache.servers : {};

  const serverRows = configured
    .filter((server) => isRecord(server) && typeof server.id === "string")
    .map((server) => {
      const stats = isRecord(indexed[server.id]) ? indexed[server.id] : {};
      return {
        id: server.id,
        displayName: typeof server.displayName === "string" ? server.displayName : server.id,
        transport: isRecord(server.transport) ? (server.transport.type ?? "unknown") : "unknown",
        trust: typeof server.trust === "string" ? server.trust : "untrusted",
        enabled: server.enabled !== false,
        status: typeof stats.status === "string" ? stats.status : "inactive",
        toolCount: Number.isFinite(stats.toolCount) ? stats.toolCount : 0,
        error: typeof stats.error === "string" ? stats.error : undefined,
        lastActivatedAt: stats.lastActivatedAt,
      };
    });

  return {
    configPath: configPath(),
    servers: serverRows,
    actions: serverRows.reduce((sum, row) => sum + row.toolCount, 0),
    skills: Number.isFinite(cache?.skills) ? cache.skills : 0,
    history: Array.isArray(cache?.history)
      ? cache.history.filter(isRecord).slice(-50).reverse()
      : [],
    context: isRecord(cache?.context) ? cache.context : null,
    indexedAt: typeof cache?.indexedAt === "string" ? cache.indexedAt : null,
    bundles: Array.isArray(config?.bundles) ? config.bundles : [],
    actionsList: [],
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
