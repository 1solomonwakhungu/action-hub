import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { resolve } from "node:path";
import type { ServerConfig } from "../types.js";

export interface DiscoveredServer extends ServerConfig {
  sourcePath: string;
  sourceClient: "claude-desktop" | "cursor" | "vscode" | "copilot" | "custom";
}

export interface DiscoveryOptions {
  cwd?: string;
  home?: string;
  customPaths?: string[];
}

/** Standard locations where popular AI and developer tools save MCP configurations. */
export function defaultDiscoveryLocations(options: DiscoveryOptions = {}): { path: string; client: DiscoveredServer["sourceClient"] }[] {
  const home = options.home ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const os = platform();

  const locations: { path: string; client: DiscoveredServer["sourceClient"] }[] = [];

  // Claude Desktop config
  if (os === "darwin") {
    locations.push({
      path: resolve(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
      client: "claude-desktop",
    });
  } else if (os === "win32") {
    const appData = process.env["APPDATA"] ?? resolve(home, "AppData", "Roaming");
    locations.push({
      path: resolve(appData, "Claude", "claude_desktop_config.json"),
      client: "claude-desktop",
    });
  } else {
    locations.push({
      path: resolve(home, ".config", "Claude", "claude_desktop_config.json"),
      client: "claude-desktop",
    });
  }

  // Cursor MCP configs
  locations.push(
    { path: resolve(home, ".cursor", "mcp.json"), client: "cursor" },
    { path: resolve(cwd, ".cursor", "mcp.json"), client: "cursor" },
  );

  // VS Code MCP configs
  locations.push(
    { path: resolve(home, ".vscode", "mcp.json"), client: "vscode" },
    { path: resolve(cwd, ".vscode", "mcp.json"), client: "vscode" },
  );

  // Copilot MCP configs
  locations.push(
    { path: resolve(home, ".copilot", "mcp.json"), client: "copilot" },
    { path: resolve(cwd, ".mcp.json"), client: "copilot" },
  );

  if (options.customPaths) {
    for (const custom of options.customPaths) {
      locations.push({ path: custom, client: "custom" });
    }
  }

  return locations;
}

/**
 * Scans known client configurations and imports standard MCP server definitions.
 */
export async function discoverMcpServers(options: DiscoveryOptions = {}): Promise<DiscoveredServer[]> {
  const locations = defaultDiscoveryLocations(options);
  const discovered: DiscoveredServer[] = [];
  const seenIds = new Set<string>();

  for (const { path, client } of locations) {
    try {
      const content = await readFile(path, "utf8");
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const servers = parseMcpServersBlock(parsed, path, client);

      for (const server of servers) {
        if (!seenIds.has(server.id)) {
          seenIds.add(server.id);
          discovered.push(server);
        }
      }
    } catch {
      // Missing or unreadable files are silently skipped during auto-discovery
    }
  }

  return discovered;
}

function parseMcpServersBlock(
  doc: Record<string, unknown>,
  sourcePath: string,
  sourceClient: DiscoveredServer["sourceClient"],
): DiscoveredServer[] {
  const results: DiscoveredServer[] = [];
  const serversBlock = doc["mcpServers"] ?? doc["servers"];

  if (typeof serversBlock !== "object" || serversBlock === null) {
    return results;
  }

  if (Array.isArray(serversBlock)) {
    // Array format: [ { id, command, args, url, ... } ]
    for (const entry of serversBlock) {
      if (typeof entry === "object" && entry !== null && typeof entry["id"] === "string") {
        const parsed = normalizeServerEntry(entry["id"], entry as Record<string, unknown>, sourcePath, sourceClient);
        if (parsed) results.push(parsed);
      }
    }
  } else {
    // Object dictionary format: { "serverName": { command, args, url, ... } }
    for (const [id, entry] of Object.entries(serversBlock)) {
      if (typeof entry === "object" && entry !== null) {
        const parsed = normalizeServerEntry(id, entry as Record<string, unknown>, sourcePath, sourceClient);
        if (parsed) results.push(parsed);
      }
    }
  }

  return results;
}

function normalizeServerEntry(
  id: string,
  raw: Record<string, unknown>,
  sourcePath: string,
  sourceClient: DiscoveredServer["sourceClient"],
): DiscoveredServer | undefined {
  if (typeof raw["url"] === "string" && raw["url"].length > 0) {
    const headers = typeof raw["headers"] === "object" && raw["headers"] !== null
      ? Object.fromEntries(
          Object.entries(raw["headers"] as Record<string, unknown>)
            .filter(([, v]) => typeof v === "string")
            .map(([k, v]) => [k, String(v)]),
        )
      : undefined;

    return {
      id,
      displayName: typeof raw["displayName"] === "string" ? raw["displayName"] : id,
      transport: {
        type: "http",
        url: raw["url"],
        headers,
      },
      trust: "untrusted",
      enabled: raw["enabled"] !== false,
      sourcePath,
      sourceClient,
    };
  }

  if (typeof raw["command"] === "string" && raw["command"].length > 0) {
    const args = Array.isArray(raw["args"])
      ? raw["args"].filter((a): a is string => typeof a === "string")
      : [];

    const env = typeof raw["env"] === "object" && raw["env"] !== null
      ? Object.fromEntries(
          Object.entries(raw["env"] as Record<string, unknown>)
            .filter(([, v]) => typeof v === "string")
            .map(([k, v]) => [k, String(v)]),
        )
      : undefined;

    return {
      id,
      displayName: typeof raw["displayName"] === "string" ? raw["displayName"] : id,
      transport: {
        type: "stdio",
        command: raw["command"],
        args,
        env,
        cwd: typeof raw["cwd"] === "string" ? raw["cwd"] : undefined,
      },
      trust: "untrusted",
      enabled: raw["enabled"] !== false,
      sourcePath,
      sourceClient,
    };
  }

  return undefined;
}
