import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  discoverAll,
  executeMigration,
  type DiscoveredPlugin,
  type DiscoveredServer,
  type DiscoveredSkill,
} from "@action-hub/core";
import { loadCliConfig } from "../config-loader.js";

export interface MigrateOptions {
  configPath?: string;
  type?: "all" | "mcps" | "skills" | "plugins";
  source?: "claude-desktop" | "cursor" | "vscode" | "copilot" | "agents" | "all";
  customPaths?: string[];
  write?: boolean;
  overwrite?: boolean;
  json?: boolean;
  skipDefaults?: boolean;
}

export async function migrateCommand(options: MigrateOptions = {}): Promise<number> {
  const isJson = options.json === true;

  if (!isJson) {
    console.log("Action Hub Capability Migration Engine\n");
    console.log("Scanning environment for MCP servers, agent skills, and plugins...\n");
  }

  const allDiscovered = await discoverAll({
    customPaths: options.customPaths,
    skipDefaults: options.skipDefaults,
  });

  // Filter by source if specified
  const sourceFilter = options.source && options.source !== "all" ? options.source : undefined;
  const filteredServers: DiscoveredServer[] = sourceFilter
    ? allDiscovered.servers.filter((s) => s.sourceClient === sourceFilter)
    : allDiscovered.servers;

  const filteredSkills: DiscoveredSkill[] = sourceFilter
    ? allDiscovered.skills.filter((s) => s.sourceClient === sourceFilter)
    : allDiscovered.skills;

  const filteredPlugins: DiscoveredPlugin[] = allDiscovered.plugins;

  // Selected types
  const typeFilter = options.type ?? "all";
  const migrationTypes: ("mcps" | "skills" | "plugins")[] =
    typeFilter === "all"
      ? ["mcps", "skills", "plugins"]
      : [typeFilter as "mcps" | "skills" | "plugins"];

  const currentConfig = await loadCliConfig(options.configPath);

  const migrationResult = executeMigration({
    existingServers: currentConfig.servers,
    existingSkills: currentConfig.skills,
    existingBundles: currentConfig.bundles,
    discovered: {
      servers: filteredServers,
      skills: filteredSkills,
      plugins: filteredPlugins,
    },
    options: {
      types: migrationTypes,
      overwrite: options.overwrite,
    },
  });

  const { plan, mergedServers, mergedSkills, mergedBundles } = migrationResult;

  if (isJson) {
    console.log(JSON.stringify({ plan, currentConfigPath: currentConfig.path }, null, 2));
  } else {
    // Print MCP Servers
    if (migrationTypes.includes("mcps")) {
      console.log(`Discovered MCP Servers (${filteredServers.length}):`);
      if (filteredServers.length === 0) {
        console.log("  No external MCP servers found.");
      } else {
        for (const s of filteredServers) {
          const transport =
            s.transport.type === "stdio"
              ? `${s.transport.command} ${(s.transport.args ?? []).join(" ")}`
              : s.transport.url;
          console.log(`  • [${s.id}] (Source: ${s.sourceClient} at ${s.sourcePath})`);
          console.log(`    Transport: ${s.transport.type} -> ${transport}`);
        }
      }
      console.log();
    }

    // Print Skills
    if (migrationTypes.includes("skills")) {
      console.log(`Discovered Skills (${filteredSkills.length}):`);
      if (filteredSkills.length === 0) {
        console.log("  No external skills found.");
      } else {
        for (const sk of filteredSkills) {
          console.log(`  • [${sk.id}] "${sk.name}" (Source: ${sk.sourceClient} at ${sk.sourcePath})`);
          console.log(`    Summary: ${sk.summary}`);
          if (sk.tags && sk.tags.length > 0) {
            console.log(`    Tags: ${sk.tags.join(", ")}`);
          }
        }
      }
      console.log();
    }

    // Print Plugins
    if (migrationTypes.includes("plugins")) {
      console.log(`Discovered Plugins (${filteredPlugins.length}):`);
      if (filteredPlugins.length === 0) {
        console.log("  No external plugins found.");
      } else {
        for (const p of filteredPlugins) {
          console.log(`  • [${p.id}] "${p.name}" (Manifest: ${p.manifestPath})`);
          console.log(
            `    Includes: ${p.servers.length} server(s), ${p.skills.length} skill(s)`,
          );
        }
      }
      console.log();
    }

    // Print Migration Plan Summary
    console.log("Migration Plan:");
    console.log(`  • Servers to add: ${plan.serversToAdd.length} (${plan.serversToAdd.map((s) => s.id).join(", ") || "none"})`);
    if (plan.serversToUpdate.length > 0) {
      console.log(`  • Servers to update: ${plan.serversToUpdate.length} (${plan.serversToUpdate.map((s) => s.id).join(", ")})`);
    }
    console.log(`  • Skills to add: ${plan.skillsToAdd.length} (${plan.skillsToAdd.map((s) => s.id).join(", ") || "none"})`);
    if (plan.skillsToUpdate.length > 0) {
      console.log(`  • Skills to update: ${plan.skillsToUpdate.length} (${plan.skillsToUpdate.map((s) => s.id).join(", ")})`);
    }
    if (plan.bundlesToAdd.length > 0) {
      console.log(`  • Plugin bundles to register: ${plan.bundlesToAdd.length} (${plan.bundlesToAdd.map((b) => b.id).join(", ")})`);
    }

    if (plan.conflicts.length > 0) {
      console.log(`\nConflicts / Skipped (${plan.conflicts.length}):`);
      for (const c of plan.conflicts) {
        console.log(`  ⚠ [${c.type}] ${c.id}: ${c.reason}`);
      }
      console.log("  (Pass `--overwrite` to replace existing configurations with newly discovered ones)");
    }
  }

  if (options.write) {
    // Preserve existing raw config to retain top-level settings like approvalTtlSeconds,
    // autoDiscover, and unexpanded environment variable references in servers.
    const raw: Record<string, unknown> = currentConfig.raw
      ? { ...currentConfig.raw }
      : {};

    const existingRawServers: Record<string, unknown>[] = Array.isArray(raw["servers"])
      ? (raw["servers"].filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null))
      : [];

    const serverEntries = [...existingRawServers];

    // Apply additions
    for (const toAdd of plan.serversToAdd) {
      if (!serverEntries.some((s) => s["id"] === toAdd.id)) {
        serverEntries.push({ ...toAdd });
      }
    }

    // Apply updates (if overwrite mode was enabled)
    for (const toUpdate of plan.serversToUpdate) {
      const idx = serverEntries.findIndex((s) => s["id"] === toUpdate.id);
      if (idx !== -1) {
        serverEntries[idx] = { ...serverEntries[idx], ...toUpdate };
      } else {
        serverEntries.push({ ...toUpdate });
      }
    }

    raw["servers"] = serverEntries;
    raw["skills"] = mergedSkills;
    raw["bundles"] = mergedBundles;
    if (raw["autoApproveAtOrAbove"] === undefined) {
      raw["autoApproveAtOrAbove"] = currentConfig.autoApproveAtOrAbove;
    }

    await mkdir(dirname(currentConfig.path), { recursive: true });
    await writeFile(currentConfig.path, JSON.stringify(raw, null, 2) + "\n", "utf8");

    if (!isJson) {
      console.log(
        `\n✔ Migration complete: Saved ${mergedServers.length} server(s), ${mergedSkills.length} skill(s), and ${mergedBundles.length} bundle(s) to ${currentConfig.path}`,
      );
    }
  } else if (!isJson) {
    console.log("\nDry run completed. Run with `--write` to save migrated capabilities to your Action Hub config.");
  }

  return 0;
}
