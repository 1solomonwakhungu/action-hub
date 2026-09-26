import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ActionHub,
  defaultCatalogCachePath,
  redactArgs,
  redactUrl,
  type ServerConfig,
} from "@action-hub/core";
import { loadCliConfig } from "../config-loader.js";
import { createSdkClientFactory } from "../client-factory.js";

export interface DoctorOptions {
  configPath?: string;
  checkConnectivity?: boolean;
}

/**
 * Resolve a repo-relative build-artifact path independent of the caller's
 * cwd: anchors on this module's compiled location (packages/cli/dist or
 * packages/cli/src) instead of process.cwd(), so `doctor` run from anywhere
 * reports build status accurately.
 */
function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return here.endsWith("dist/commands") || here.endsWith("src/commands")
    ? resolve(here, "..", "..")
    : here;
}

function describeTransport(transport: ServerConfig["transport"]): string {
  if (transport.type === "stdio") {
    return `${transport.command} ${(redactArgs(transport.args) ?? []).join(" ")}`;
  }
  return redactUrl(transport.url);
}

export async function doctorCommand(options: DoctorOptions = {}): Promise<number> {
  console.log("Action Hub System Diagnostics & Health Check\n");

  let criticalFailures = 0;

  // 1. Node.js Version Check
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split(".")[0] ?? "0", 10);
  const minor = parseInt(nodeVersion.slice(1).split(".")[1] ?? "0", 10);
  const nodeOk = major > 20 || (major === 20 && minor >= 11);
  if (nodeOk) {
    console.log(`✔ Node.js runtime: ${nodeVersion} (compatible >= v20.11.0)`);
  } else {
    console.log(`✖ Node.js runtime: ${nodeVersion} (INCOMPATIBLE: requires >= v20.11.0)`);
    criticalFailures++;
  }

  // 2. Build Status (anchored on this module's location, not cwd)
  const root = packageRoot();
  const coreDist = resolve(root, "..", "core", "dist");
  const copilotDist = resolve(root, "..", "copilot-plugin", "server", "dist");
  let buildOk = true;
  try {
    const st1 = await stat(coreDist);
    if (!st1.isDirectory()) buildOk = false;
    const st2 = await stat(copilotDist);
    if (!st2.isDirectory()) buildOk = false;
  } catch {
    buildOk = false;
  }
  if (buildOk) {
    console.log("✔ Workspace builds: Core and Plugin build artifacts verified");
  } else {
    console.log("⚠ Workspace builds: One or more build artifacts missing (run `npm run build`)");
  }

  // 3. Configuration Discovery & Syntax
  const config = await loadCliConfig(options.configPath);
  console.log(`\nConfiguration:`);
  console.log(`  File location: ${config.path}`);
  console.log(`  File exists:   ${config.exists ? "Yes" : "No (using defaults / auto-discovery)"}`);
  console.log(`  Configured servers: ${config.servers.length}`);
  console.log(`  Configured bundles: ${config.bundles.length}`);
  console.log(`  Auto-approve at or above: ${config.autoApproveAtOrAbove}`);

  // 4. Cache Health
  const cachePath = defaultCatalogCachePath();
  try {
    const st = await stat(cachePath);
    console.log(`✔ Catalog Cache: active at ${cachePath} (${st.size} bytes)`);
  } catch {
    console.log(`ℹ Catalog Cache: not yet generated at ${cachePath} (generated on first index)`);
  }

  if (config.servers.length === 0) {
    console.log("\n⚠ No MCP servers configured. Run `action-hub import` to detect servers from other apps.");
    return criticalFailures > 0 ? 1 : 0;
  }

  // 5. Downstream Server Connectivity & Indexing Status
  const factory = createSdkClientFactory();
  const hub = new ActionHub({
    servers: config.servers,
    bundles: config.bundles,
    clientFactory: factory,
  });

  try {
    console.log("\nServer Connectivity & Indexing Status:");
    const indexResults = await hub.indexAll();

    for (const res of indexResults) {
      const srv = config.servers.find((s) => s.id === res.serverId);
      const transportType = srv?.transport.type ?? "unknown";
      // Secret-bearing args and URL query values are redacted for display.
      const transportDesc = srv ? describeTransport(srv.transport) : "";

      if (res.error) {
        criticalFailures++;
        console.log(`  ✖ [${res.serverId}] (${transportType}) ${transportDesc}`);
        console.log(`    Error: ${res.error}`);
      } else {
        console.log(`  ✔ [${res.serverId}] (${transportType}) ${res.indexed} tools indexed`);
      }
    }

    // 6. Latency & Health Probing
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

    console.log("\nResilience:");
    for (const state of hub.serverStates()) {
      const memory = state.memoryLimitMb ? `${state.memoryLimitMb} MB` : "unset";
      const restart = state.nextRestartAt ? `; next restart ${state.nextRestartAt}` : "";
      console.log(
        `  [${state.id}] circuit=${state.circuitState ?? "closed"} failures=${state.consecutiveFailures ?? 0} memory=${memory}${restart}`,
      );
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

    return criticalFailures > 0 ? 1 : 0;
  } finally {
    await hub.close();
  }
}
