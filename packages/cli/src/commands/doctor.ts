import { ActionHub } from "@action-hub/core";
import { loadCliConfig } from "../config-loader.js";
import { createSdkClientFactory } from "../client-factory.js";

export interface DoctorOptions {
  configPath?: string;
  checkConnectivity?: boolean;
}

export async function doctorCommand(options: DoctorOptions = {}): Promise<number> {
  console.log("Action Hub System Diagnostics & Health Check\n");

  const config = await loadCliConfig(options.configPath);

  console.log("Configuration:");
  console.log(`  File location: ${config.path}`);
  console.log(`  File exists:   ${config.exists ? "Yes" : "No (using defaults / auto-discovery)"}`);
  console.log(`  Configured servers: ${config.servers.length}`);
  console.log(`  Configured bundles: ${config.bundles.length}`);
  console.log(`  Auto-approve at or above: ${config.autoApproveAtOrAbove}`);
  console.log("");

  if (config.servers.length === 0) {
    console.log("⚠ No MCP servers configured. Run `action-hub import` to detect servers from other apps.");
    return 0;
  }

  const factory = createSdkClientFactory();
  const hub = new ActionHub({
    servers: config.servers,
    bundles: config.bundles,
    clientFactory: factory,
  });

  console.log("Indexing servers...");
  const indexResults = await hub.indexAll();

  console.log("\nServer Connectivity & Indexing Status:");
  let failures = 0;

  for (const res of indexResults) {
    const srv = config.servers.find((s) => s.id === res.serverId);
    const transportType = srv?.transport.type ?? "unknown";
    const transportDesc =
      srv?.transport.type === "stdio"
        ? `${srv.transport.command} ${(srv.transport.args ?? []).join(" ")}`
        : srv?.transport.type === "http"
          ? srv.transport.url
          : "";

    if (res.error) {
      failures++;
      console.log(`  ✖ [${res.serverId}] (${transportType}) ${transportDesc}`);
      console.log(`    Error: ${res.error}`);
    } else {
      console.log(`  ✔ [${res.serverId}] (${transportType}) ${res.indexed} tools indexed`);
    }
  }

  // Health checks / Latency probing
  if (options.checkConnectivity !== false && indexResults.some((r) => !r.error)) {
    console.log("\nProbing Server Latency & Health:");
    const healthResults = await hub.checkAllHealth();
    for (const h of healthResults) {
      if (h.status === "ready") {
        console.log(`  ✔ [${h.serverId}] Status: ${h.status} (${h.latencyMs ?? 0}ms latency)`);
      } else {
        console.log(`  ✖ [${h.serverId}] Status: ${h.status} ${h.error ? `(${h.error})` : ""}`);
      }
    }
  }

  const stats = hub.contextStats();
  console.log("\nContext Savings Estimate:");
  console.log(`  Total tools indexed:   ${stats.actions}`);
  console.log(`  Eager tokens estimate: ${stats.eagerTokensEstimate}`);
  console.log(`  Hub tokens estimate:   ${stats.hubTokensEstimate}`);
  const savings =
    stats.eagerTokensEstimate > 0
      ? Math.round(((stats.eagerTokensEstimate - stats.hubTokensEstimate) / stats.eagerTokensEstimate) * 100)
      : 0;
  console.log(`  Estimated token savings per turn: ~${savings}%`);

  return failures > 0 ? 1 : 0;
}
