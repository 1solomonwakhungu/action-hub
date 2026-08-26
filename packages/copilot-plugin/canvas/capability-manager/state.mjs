import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

function configPath() {
  const fromEnv = process.env.ACTION_HUB_CONFIG;
  if (fromEnv) return fromEnv;
  return resolve(homedir(), ".config", "action-hub", "servers.json");
}

function cachePath() {
  return resolve(homedir(), ".cache", "action-hub", "catalog.json");
}

/**
 * The canvas reads the same config the MCP server reads, plus the catalog
 * snapshot the server writes after indexing. It deliberately does not connect
 * to downstream servers itself — the hub owns every connection.
 */
export async function readState() {
  const [config, cache] = await Promise.all([readJson(configPath()), readJson(cachePath())]);

  const configured = Array.isArray(config?.servers) ? config.servers : [];
  const indexed = cache?.servers ?? {};

  const serverRows = configured.map((server) => {
    const stats = indexed[server.id] ?? {};
    return {
      id: server.id,
      displayName: server.displayName ?? server.id,
      transport: server.transport?.type ?? "unknown",
      trust: server.trust ?? "untrusted",
      enabled: server.enabled !== false,
      status: stats.status ?? "inactive",
      toolCount: stats.toolCount ?? 0,
      error: stats.error,
      lastActivatedAt: stats.lastActivatedAt,
    };
  });

  return {
    configPath: configPath(),
    servers: serverRows,
    actions: serverRows.reduce((sum, row) => sum + row.toolCount, 0),
    skills: cache?.skills ?? 0,
    history: Array.isArray(cache?.history) ? cache.history.slice(-50).reverse() : [],
    context: cache?.context ?? null,
    indexedAt: cache?.indexedAt ?? null,
  };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
