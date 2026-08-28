import { ActionHub } from "@action-hub/core";
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
    servers: config.servers,
    bundles: config.bundles,
    clientFactory: factory,
  });

  await hub.indexAll();

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
}
