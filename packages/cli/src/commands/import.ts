import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { discoverMcpServers, type ServerConfig } from "@action-hub/core";
import { loadCliConfig } from "../config-loader.js";

export interface ImportOptions {
  configPath?: string;
  source?: "claude-desktop" | "cursor" | "vscode" | "copilot" | "all";
  write?: boolean;
}

export async function importCommand(options: ImportOptions = {}): Promise<number> {
  console.log("Action Hub Server Import & Auto-Discovery\n");

  const discovered = await discoverMcpServers();
  const filter = options.source && options.source !== "all" ? options.source : undefined;
  const filtered = filter ? discovered.filter((d) => d.sourceClient === filter) : discovered;

  console.log(`Discovered ${filtered.length} server(s) from local configurations:`);
  if (filtered.length === 0) {
    console.log("  No external MCP servers found.");
    return 0;
  }

  for (const s of filtered) {
    const transport =
      s.transport.type === "stdio"
        ? `${s.transport.command} ${(s.transport.args ?? []).join(" ")}`
        : s.transport.url;
    console.log(`  • [${s.id}] (Source: ${s.sourceClient} at ${s.sourcePath})`);
    console.log(`    Transport: ${s.transport.type} -> ${transport}`);
  }

  if (options.write) {
    const currentConfig = await loadCliConfig(options.configPath);
    const existing = new Map<string, ServerConfig>(currentConfig.servers.map((s) => [s.id, s]));

    let added = 0;
    for (const d of filtered) {
      if (!existing.has(d.id)) {
        const cleanServer: ServerConfig = {
          id: d.id,
          displayName: d.displayName,
          transport: d.transport,
          trust: d.trust ?? "untrusted",
          enabled: d.enabled !== false,
        };
        existing.set(d.id, cleanServer);
        added++;
      }
    }

    const payload = {
      servers: [...existing.values()],
      bundles: currentConfig.bundles,
      autoApproveAtOrAbove: currentConfig.autoApproveAtOrAbove,
    };

    await mkdir(dirname(currentConfig.path), { recursive: true });
    await writeFile(currentConfig.path, JSON.stringify(payload, null, 2) + "\n", "utf8");
    console.log(`\n✔ Saved ${added} new server(s) to ${currentConfig.path}`);
  } else {
    console.log("\nRun with `--write` to save discovered servers to your Action Hub config.");
  }

  return 0;
}
