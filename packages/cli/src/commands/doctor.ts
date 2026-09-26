import { stat } from "node:fs/promises";
import {
  ActionHub,
  defaultCatalogCachePath,
  redactArgs,
  redactUrl,
  sanitizeErrorForServer,
  type ServerConfig,
} from "@action-hub/core";
import { loadCliConfig } from "../config-loader.js";
import { createSdkClientFactory } from "../client-factory.js";

export interface DoctorOptions {
  configPath?: string;
  checkConnectivity?: boolean;
}

/** Settle delay before a retry attempt (deterministic, bounded). */
const RETRY_SETTLE_MS = 250;
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  // 2. Configuration Discovery & Syntax
  const config = await loadCliConfig(options.configPath);
  console.log(`\nConfiguration:`);
  console.log(`  File location: ${config.path}`);
  console.log(`  File exists:   ${config.exists ? "Yes" : "No (using defaults / auto-discovery)"}`);
  console.log(`  Configured servers: ${config.servers.length}`);
  console.log(`  Configured bundles: ${config.bundles.length}`);
  console.log(`  Auto-approve at or above: ${config.autoApproveAtOrAbove}`);

  // 3. Cache Health
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

  // 4. Downstream Server Connectivity & Indexing Status
  const factory = createSdkClientFactory();
  const hub = new ActionHub({
    servers: config.servers,
    bundles: config.bundles,
    clientFactory: factory,
  });

  try {
    console.log("\nServer Connectivity & Indexing Status:");
    // Deterministic rule (F17): a fleet with flapping servers used to make the
    // doctor exit 0 or 1 depending on check timing — a single-shot index or
    // health probe could land inside a flap window. Each server therefore gets
    // a bounded number of attempts (one retry after a settle delay) and the
    // probes run serially, so the exit code is explainable: 1 iff any enabled
    // server is still down at check time after the retry.
    const indexResults: { serverId: string; indexed: number; error?: string; attempts: number }[] = [];
    for (const res of await hub.indexAll()) {
      if (res.error && config.servers.find((s) => s.id === res.serverId)?.enabled !== false) {
        await delay(RETRY_SETTLE_MS);
        const retry = await hub.indexServer(res.serverId);
        indexResults.push({ ...retry, attempts: 2 });
        continue;
      }
      indexResults.push({ ...res, attempts: 1 });
    }

    for (const res of indexResults) {
      const srv = config.servers.find((s) => s.id === res.serverId);
      const transportType = srv?.transport.type ?? "unknown";
      // Secret-bearing args and URL query values are redacted for display.
      const transportDesc = srv ? describeTransport(srv.transport) : "";
      // Distinguish a server that came back on the retry from one that is
      // still down after it — the label must not claim recovery that the
      // final attempt did not deliver.
      const attemptNote =
        res.attempts > 1 ? (res.error ? " (still failing after retry)" : " (recovered on retry)") : "";

      if (res.error) {
        criticalFailures++;
        console.log(`  ✖ [${res.serverId}] (${transportType}) ${transportDesc}${attemptNote}`);
        // Error text may echo the server's own configuration (URLs, args,
        // env); every secret value is redacted before printing.
        console.log(`    Error: ${srv ? sanitizeErrorForServer(srv, res.error) : res.error}`);
      } else {
        console.log(`  ✔ [${res.serverId}] (${transportType}) ${res.indexed} tools indexed${attemptNote}`);
      }
    }

    // 5. Latency & Health Probing
    if (options.checkConnectivity !== false && indexResults.some((r) => !r.error)) {
      console.log("\nProbing Server Latency & Health:");
      // Serial, bounded, one retry: probe each enabled server once; on a
      // failure, settle briefly and probe once more. The final attempt decides.
      const healthResults = [];
      for (const srv of config.servers) {
        const first = await hub.checkHealth(srv.id);
        if (first.status === "ready" || first.status === "disabled") {
          healthResults.push({ ...first, attempts: 1 });
          continue;
        }
        await delay(RETRY_SETTLE_MS);
        const second = await hub.checkHealth(srv.id);
        healthResults.push({ ...second, attempts: 2 });
      }
      for (const h of healthResults) {
        const srv = config.servers.find((s) => s.id === h.serverId);
        if (srv?.enabled === false || h.status === "disabled") {
          console.log(`  ℹ [${h.serverId}] intentionally disabled; health probe skipped`);
          continue;
        }
        const attemptNote =
          h.attempts > 1 ? (h.status === "ready" ? " (recovered on retry)" : ` (${h.attempts} attempts)`) : "";
        if (h.status === "ready") {
          console.log(`  ✔ [${h.serverId}] Status: ${h.status} (${h.latencyMs ?? 0}ms latency)${attemptNote}`);
        } else {
          criticalFailures++;
          const detail = h.error
            ? (srv ? sanitizeErrorForServer(srv, h.error) : h.error)
            : "";
          console.log(`  ✖ [${h.serverId}] Status: ${h.status} (${h.attempts} attempts) ${detail ? `(${detail})` : ""}`);
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
