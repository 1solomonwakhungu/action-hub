import { ActionHub } from "@action-hub/core";
import { loadCliConfig } from "../config-loader.js";
import { createSdkClientFactory } from "../client-factory.js";

export interface TestSearchOptions {
  configPath?: string;
  limit?: number;
  threshold?: number;
  server?: string;
}

export async function testSearchCommand(query: string, options: TestSearchOptions = {}): Promise<number> {
  if (!query || query.trim().length === 0) {
    console.error("Error: Search query is required. Usage: action-hub test-search <query>");
    return 1;
  }

  const config = await loadCliConfig(options.configPath);
  const factory = createSdkClientFactory();
  const hub = new ActionHub({
    servers: config.servers,
    bundles: config.bundles,
    clientFactory: factory,
  });

  console.log(`Searching catalog for: "${query}"...\n`);
  await hub.indexAll();

  const hits = await hub.search(query, {
    limit: options.limit ?? 10,
    serverIds: options.server ? [options.server] : undefined,
  });

  if (hits.length === 0) {
    console.log("No matching tools or skills found.");
    return 0;
  }

  console.log(`Found ${hits.length} result(s):\n`);
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!;
    const scorePct = hit.score ? (hit.score * 100).toFixed(1) + "%" : "N/A";
    console.log(`${i + 1}. [${hit.id}]  (Score: ${scorePct}, Kind: ${hit.kind})`);
    console.log(`   Summary: ${hit.summary}`);
    console.log("");
  }

  // Also check if any bundle matches the query
  const bundleHits = hub.searchBundles(query);
  if (bundleHits.length > 0) {
    console.log(`Matching Action Bundles (${bundleHits.length}):`);
    for (const b of bundleHits) {
      console.log(`  • [bundle:${b.id}] "${b.displayName}": ${b.description ?? ""}`);
      console.log(`    Action IDs: ${(b.actionIds ?? []).join(", ")}`);
    }
  }

  return 0;
}
