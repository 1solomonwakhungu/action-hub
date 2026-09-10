import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Bundle, ServerConfig, SkillConfig, TrustTier } from "@action-hub/core";
import { discoverMcpServers } from "@action-hub/core";

export interface CliConfig {
  path: string;
  exists: boolean;
  servers: ServerConfig[];
  skills: SkillConfig[];
  bundles: Bundle[];
  autoApproveAtOrAbove: TrustTier;
  raw?: Record<string, unknown>;
}

export function defaultConfigPath(): string {
  const fromEnv = process.env["ACTION_HUB_CONFIG"];
  if (fromEnv && fromEnv.length > 0) return resolvePath(fromEnv);
  return resolve(homedir(), ".config", "action-hub", "servers.json");
}

export function resolvePath(path: string): string {
  if (path.startsWith("~")) {
    return resolve(homedir(), path.slice(1).replace(/^[/\\\\]+/, ""));
  }
  return resolve(process.cwd(), path);
}

export async function loadCliConfig(configPath?: string): Promise<CliConfig> {
  const targetPath = configPath ? resolvePath(configPath) : defaultConfigPath();
  let exists = false;
  let raw: Record<string, unknown> | undefined;
  let servers: ServerConfig[] = [];
  let skills: SkillConfig[] = [];
  let bundles: Bundle[] = [];
  let autoApproveAtOrAbove: TrustTier = "trusted";

  try {
    const text = await readFile(targetPath, "utf8");
    raw = JSON.parse(text) as Record<string, unknown>;
    exists = true;

    if (Array.isArray(raw["servers"])) {
      servers = raw["servers"].filter(
        (s): s is ServerConfig => typeof s === "object" && s !== null && typeof s["id"] === "string",
      );
    }
    if (Array.isArray(raw["skills"])) {
      skills = raw["skills"].filter(
        (sk): sk is SkillConfig => typeof sk === "object" && sk !== null && typeof sk["id"] === "string",
      );
    }
    if (Array.isArray(raw["bundles"])) {
      bundles = raw["bundles"].filter(
        (b): b is Bundle => typeof b === "object" && b !== null && typeof b["id"] === "string",
      );
    }
    if (
      raw["autoApproveAtOrAbove"] === "trusted" ||
      raw["autoApproveAtOrAbove"] === "untrusted" ||
      raw["autoApproveAtOrAbove"] === "blocked"
    ) {
      autoApproveAtOrAbove = raw["autoApproveAtOrAbove"];
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `Failed to parse config at ${targetPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Auto-discover if not explicitly disabled
  if (!raw || raw["autoDiscover"] !== false) {
    try {
      const discovered = await discoverMcpServers();
      const existingIds = new Set(servers.map((s) => s.id));
      for (const d of discovered) {
        if (!existingIds.has(d.id)) {
          existingIds.add(d.id);
          servers.push(d);
        }
      }
    } catch {
      // Ignored
    }
  }

  return {
    path: targetPath,
    exists,
    servers,
    skills,
    bundles,
    autoApproveAtOrAbove,
    raw,
  };
}
