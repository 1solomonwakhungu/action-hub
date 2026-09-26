import { homedir } from "node:os";
import { resolve } from "node:path";
import { ActionHub } from "@action-hub/core";
import { discoverSkillsFromDirectory } from "@action-hub/core";
import { loadCliConfig } from "../config-loader.js";
import { createSdkClientFactory } from "../client-factory.js";

export interface ListOptions {
  configPath?: string;
  server?: string;
  kind?: "tool" | "skill" | "all";
}

export async function listCommand(options: ListOptions = {}): Promise<number> {
  const config = await loadCliConfig(options.configPath);
  const factory = createSdkClientFactory();
  const hub = new ActionHub({
    servers: options.server
      ? config.servers.filter((s) => s.id === options.server)
      : config.servers,
    bundles: config.bundles,
    clientFactory: factory,
  });

  try {
    // Skills are registered exactly like the runtime does: config entries
    // first, then the skills directory, with the config entry winning on id
    // collisions. This keeps `list --kind skill` consistent with what the MCP
    // server actually serves.
    const skillsDir =
      process.env["ACTION_HUB_SKILLS_DIR"] ?? resolve(homedir(), ".action-hub", "skills");
    const dirSkills = await discoverSkillsFromDirectory(skillsDir);
    const configSkillIds = new Set((config.skills ?? []).map((s) => s.id));
    const skillRecords = [
      ...(config.skills ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        serverId: s.sourceClient ?? "skills",
        summary: s.summary,
        description: s.description,
        tags: s.tags,
        trust: s.trust ?? ("trusted" as const),
      })),
      ...dirSkills
        .filter((s) => !configSkillIds.has(s.id))
        .map((s) => ({
          id: s.id,
          name: s.name,
          serverId: s.sourceClient ?? "skills",
          summary: s.summary,
          description: s.description,
          tags: s.tags,
          trust: s.trust ?? ("trusted" as const),
        })),
    ];
    hub.replaceSkills(skillRecords);

    if (options.server) {
      // F12: index only the requested server instead of the whole fleet.
      const exists = config.servers.some((s) => s.id === options.server);
      if (!exists) {
        console.error(`Error: server "${options.server}" is not registered in the config.`);
        return 1;
      }
      const result = await hub.indexServer(options.server);
      if (result.error) {
        console.error(`Warning: indexing "${options.server}" failed: ${result.error}`);
      }
    } else {
      await hub.indexAll();
    }

    let actions = hub.catalog.all();
    if (options.server) {
      actions = actions.filter((a) => a.serverId === options.server);
    }
    if (options.kind && options.kind !== "all") {
      actions = actions.filter((a) => a.kind === options.kind);
    }

    console.log(`Action Hub Catalog (${actions.length} action(s)):\n`);

    const byServer = new Map<string, typeof actions>();
    for (const a of actions) {
      const list = byServer.get(a.serverId) ?? [];
      list.push(a);
      byServer.set(a.serverId, list);
    }

    for (const [serverId, serverActions] of byServer.entries()) {
      console.log(`Server: ${serverId} (${serverActions.length} action(s))`);
      for (const a of serverActions) {
        console.log(`  • ${a.name}  [${a.trust}] (${a.kind})`);
        console.log(`    ${a.summary}`);
      }
      console.log("");
    }

    if (config.bundles.length > 0) {
      console.log(`Action Bundles (${config.bundles.length}):`);
      for (const b of config.bundles) {
        console.log(`  • [bundle:${b.id}] "${b.displayName}" (${(b.actionIds ?? []).length} actionIds)`);
        console.log(`    ${b.description ?? ""}`);
      }
    }

    return 0;
  } finally {
    // F10: close MCP client connections so no dangling handle keeps the
    // process alive after the command completes.
    await hub.close();
  }
}
