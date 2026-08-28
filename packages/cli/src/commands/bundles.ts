import { ActionHub } from "@action-hub/core";
import { loadCliConfig } from "../config-loader.js";

export interface BundleOptions {
  configPath?: string;
  load?: string;
}

export async function bundlesCommand(options: BundleOptions = {}): Promise<number> {
  const config = await loadCliConfig(options.configPath);
  const hub = new ActionHub({
    servers: config.servers,
    bundles: config.bundles,
    clientFactory: async () => {
      throw new Error("Client execution not needed for bundle inspection");
    },
  });

  if (options.load) {
    try {
      const bundle = hub.loadBundle(options.load);
      console.log(`Loaded Bundle: "${bundle.displayName}" (${bundle.id})\n`);
      console.log(`Description: ${bundle.description ?? "(no description)"}`);
      console.log(`Actions (${bundle.actions.length}):`);
      for (const a of bundle.actions) {
        console.log(`  • ${a.name} (${a.serverId}) - [${a.trust}]`);
        console.log(`    ${a.summary}`);
      }
      return 0;
    } catch (err) {
      console.error(`Error loading bundle "${options.load}": ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  const all = hub.bundles.list();
  console.log(`Registered Bundles (${all.length}):\n`);
  for (const b of all) {
    console.log(`• [${b.id}] "${b.displayName}"`);
    console.log(`  Description: ${b.description ?? "(no description)"}`);
    console.log(`  Included Actions: ${(b.actionIds ?? []).join(", ")}`);
    console.log("");
  }

  return 0;
}
