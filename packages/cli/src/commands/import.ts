import { discoverMcpServers, redactServerConfig, type ServerConfig } from "@action-hub/core";
import { loadCliConfig } from "../config-loader.js";
import { rawConfigDocument, writeConfigAtomic } from "../config-writer.js";

/** Harness source filters accepted by the import command. */
export const IMPORT_SOURCE_FILTERS = [
  "claude-desktop",
  "cursor",
  "vscode",
  "copilot",
  "codex",
  "windsurf",
  "cline",
  "roo-code",
] as const;

export type ImportSourceFilter = (typeof IMPORT_SOURCE_FILTERS)[number];

export interface ImportOptions {
  configPath?: string;
  source?: ImportSourceFilter | "all";
  write?: boolean;
}

export async function importCommand(options: ImportOptions = {}): Promise<number> {
  console.log("Action Hub Server Import & Auto-Discovery\n");

  // With --write, load (and validate) the config before any early return so a
  // malformed existing config fails with exit 1 and is never overwritten.
  const writeConfig = options.write ? await loadCliConfig(options.configPath) : undefined;
  if (writeConfig) rawConfigDocument(writeConfig);

  const discovered = await discoverMcpServers();
  const filter = options.source && options.source !== "all" ? options.source : undefined;
  const filtered = filter ? discovered.filter((d) => d.sourceClient === filter) : discovered;

  console.log(`Discovered ${filtered.length} server(s) from local configurations:`);
  if (filtered.length === 0) {
    console.log("  No external MCP servers found.");
    return 0;
  }

  for (const s of filtered) {
    // Display-only projection: env/header values, secret-bearing args, URL
    // query values and OAuth config are redacted before rendering.
    const t = redactServerConfig(s).transport;
    const transport =
      t.type === "stdio" ? `${t.command} ${(t.args ?? []).join(" ")}` : t.url;
    console.log(`  • [${s.id}] (Source: ${s.sourceClient} at ${s.sourcePath})`);
    console.log(`    Transport: ${t.type} -> ${transport}`);
    if (t.type === "stdio" && t.env) {
      console.log(`    Env: ${Object.keys(t.env).join(", ")}`);
    }
  }

  if (options.write) {
    const currentConfig = writeConfig!;

    // The raw document is the merge base: skills, autoDiscover, custom
    // top-level keys, and unexpanded env references in existing servers must
    // all survive a write. Existing server entries always win — import only
    // adds what is missing.
    const raw = rawConfigDocument(currentConfig);
    const existingRawServers: Record<string, unknown>[] = Array.isArray(raw["servers"])
      ? raw["servers"].filter(
          (s): s is Record<string, unknown> => typeof s === "object" && s !== null,
        )
      : [];
    const serverEntries = [...existingRawServers];

    let added = 0;
    for (const d of filtered) {
      if (!serverEntries.some((s) => s["id"] === d.id)) {
        const cleanServer = {
          id: d.id,
          displayName: d.displayName,
          transport: d.transport,
          trust: d.trust ?? "untrusted",
          enabled: d.enabled !== false,
        } as Record<string, unknown>;
        serverEntries.push(cleanServer);
        added++;
      }
    }
    raw["servers"] = serverEntries;

    await writeConfigAtomic(currentConfig.path, raw);
    console.log(`\n✔ Saved ${added} new server(s) to ${currentConfig.path}`);
  } else {
    console.log("\nRun with `--write` to save discovered servers to your Action Hub config.");
  }

  return 0;
}
