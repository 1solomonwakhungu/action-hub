import { stat } from "node:fs/promises";
import {
  ActionHub,
  defaultCatalogCachePath,
  redactArgs,
  redactUrl,
  sanitizeErrorForServer,
  type McpClient,
  type ServerConfig,
} from "@action-hub/core";
import { loadCliConfig } from "../config-loader.js";
import { ANCHOR_SRC, EXIT_PROVEN, teardownAnchorChild, type TeardownResult } from "./process-anchor.js";
import type { ChildProcess } from "node:child_process";
import { createSdkClientFactory } from "../client-factory.js";

export interface DoctorOptions {
  configPath?: string;
  checkConnectivity?: boolean;
  /** Total budget for all servers and attempts (ms). Default 120000. */
  deadlineMs?: number;
}

/** Settle delay before a retry attempt (deterministic, bounded). */
const RETRY_SETTLE_MS = 250;
/**
 * Extra time on top of the server's own timeoutMs that a connect attempt gets
 * before the doctor gives up on it. The core's execution timeout only starts
 * AFTER activation returns, and the SDK client.connect() has no deadline of
 * its own (F27, core-side), so without this bound a permanently hanging
 * initialize would hang the doctor forever. The doctor-side factory bounds
 * every connect AND closes the transport of a timed-out attempt so no child
 * survives.
 */
const ACTIVATION_SLACK_MS = 2_000;
/** Timeout used when a server config does not define one. */
const DEFAULT_SERVER_TIMEOUT_MS = 5_000;
/**
 * Total doctor budget (activation + listTools + health, all servers, both
 * attempts). Without it, worst case scales 44 servers x 2 attempts x per-
 * server timeout. Overridable via ACTION_HUB_DOCTOR_DEADLINE_MS.
 */
const DEFAULT_DOCTOR_BUDGET_MS = 120_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serverTimeoutMs(srv: ServerConfig | undefined): number {
  return typeof srv?.timeoutMs === "number" && srv.timeoutMs > 0 ? srv.timeoutMs : DEFAULT_SERVER_TIMEOUT_MS;
}

/**
 * Routes stdio servers through the anchored supervisor (process-anchor.ts) so
 * every server runs inside a wrapper-owned process group whose leader we
 * spawned ourselves. The anchor records wrapper/server PIDs to a meta file
 * BEFORE the client connects, so a server that hangs during initialize (F27:
 * activation has no deadline in core) can be torn down exactly — regardless
 * of whether it ever wrote valid stdout. HTTP servers are unaffected. The
 * original transport description is preserved for display.
 */
function supervisedServers(servers: readonly ServerConfig[]): ServerConfig[] {
  return servers.map((srv) => {
    if (srv.transport.type !== "stdio") return srv;
    const transport = srv.transport;
    const env = {
      ...(transport.env ?? {}),
      ANCHOR_STDOUT_DEADLINE_MS: String(Math.max(1_000, serverTimeoutMs(srv))),
    };
    return {
      ...srv,
      transport: {
        type: "stdio",
        command: process.execPath,
        args: ["-e", ANCHOR_SRC, "doctor", transport.command, ...(transport.args ?? [])],
        env,
        ...(transport.cwd ? { cwd: transport.cwd } : {}),
      },
    } as ServerConfig;
  });
}

function attemptBudgetMs(srv: ServerConfig | undefined): number {
  return serverTimeoutMs(srv) + ACTIVATION_SLACK_MS;
}

function doctorBudgetMs(explicit?: number): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) return explicit;
  const envRaw = process.env["ACTION_HUB_DOCTOR_DEADLINE_MS"];
  if (envRaw) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_DOCTOR_BUDGET_MS;
}

/** Races `op` against a deadline; on timeout, rejects with a labeled error. */
function withDeadline<T>(label: string, op: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([op(), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Wraps the SDK client factory with an activation deadline. The core starts
 * its own timeout only after activation returns, so a server whose initialize
 * never completes would otherwise hang the doctor forever. On timeout the
 * eventual client (if it ever connects) is closed so no transport or child
 * process survives the attempt.
 */
function boundedClientFactory(
  inner: (config: ServerConfig) => Promise<McpClient>,
  config: ServerConfig,
  anchorRef: () => ChildProcess | undefined,
  anchorTeardowns: Promise<void>[],
  onTeardownResult: (res: TeardownResult) => void,
): Promise<McpClient> {
  return (async () => {
    const deadline = attemptBudgetMs(config);
    const clientPromise = (async () => inner(config))();
    // Swallow a late rejection so the loser of the race cannot surface as an
    // unhandled rejection after the race has already decided.
    clientPromise.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Bounded activation: terminate THIS attempt's anchor (the exact
        // handle the SDK issued; the anchor runs its own gated group cleanup
        // from inside) — a partial-stdout server that never completes
        // initialize is still torn down — then close the eventual transport
        // of the timed-out attempt if it ever connects.
        const anchorChild = anchorRef();
        if (anchorChild) {
          // Awaited at doctor teardown: only proven:true with zero survivors
          // counts as success; any false result fails the doctor.
          anchorTeardowns.push(
            teardownAnchorChild(anchorChild, 5_000).then(onTeardownResult),
          );
        }
        void clientPromise.then((client) => client.close()).catch(() => undefined);
        reject(new Error(`connect timed out after ${deadline}ms`));
      }, deadline);
    });
    try {
      const client = (await Promise.race([clientPromise, timeout])) as McpClient;
      return client;
    } finally {
      if (timer) clearTimeout(timer);
    }
  })();
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
  const supervised = supervisedServers(config.servers);
  // The doctor HOLDS each attempt's anchor ChildProcess (captured from the
  // transport child at spawn via the client-factory hook) — no disk PID
  // metadata anywhere, and identity is the exact handle the SDK issued, not
  // a reconstructed number. Attempt 2's spawn replaces attempt 1's handle in
  // THIS attempt's closure, so retries are associated correctly.
  const anchorTeardowns: Promise<void>[] = [];
  const heldAnchors: ChildProcess[] = [];
  let teardownSurvivors: number[] = [];
  let teardownProven = true;
  const hub = new ActionHub({
    servers: supervised,
    bundles: config.bundles,
    // Bounded activation: the core's execution timeout starts only AFTER the
    // client connects, and client.connect() has no deadline of its own, so a
    // permanently hanging initialize would otherwise hang the doctor. The
    // wrapped factory bounds every connect attempt and tears the attempt's
    // own anchor tree down at its deadline (no child survives).
    clientFactory: (config) => {
      let anchorChild: ChildProcess | undefined;
      const childFactory = createSdkClientFactory({
        onChildSpawn: (spawnedConfig, child) => {
          if (spawnedConfig.id === config.id) {
            anchorChild = child;
            heldAnchors.push(child);
          }
        },
      });
      return boundedClientFactory(childFactory, config, () => anchorChild, anchorTeardowns, (res) => {
        if (!res.proven) teardownProven = false;
        teardownSurvivors.push(...res.survivors);
      });
    },
  });

  // Total budget across all servers and both attempts, so worst case cannot
  // multiply servers x attempts x per-server timeout.
  const budgetStart = Date.now();
  const budget = doctorBudgetMs(options.deadlineMs);
  const budgetLeft = (): number => Math.max(0, budget - (Date.now() - budgetStart));

  let result = 0;
  try {
    console.log("\nServer Connectivity & Indexing Status:");
    // Deterministic rule (F17): a fleet with flapping servers used to make the
    // doctor exit 0 or 1 depending on check timing — a single-shot index or
    // health probe could land inside a flap window. Each server therefore gets
    // a bounded number of attempts (one retry after a settle delay) and the
    // probes run serially, so the exit code is explainable: 1 iff any enabled
    // server is still down at check time after the retry.
    const enabledServers = config.servers.filter((s) => s.enabled !== false);
    type IndexRow = { serverId: string; indexed: number; error?: string; attempts: number; skipped?: boolean };
    const indexResults: IndexRow[] = [];
    for (const srv of enabledServers) {
      if (budgetLeft() <= 0) {
        indexResults.push({ serverId: srv.id, indexed: 0, error: "global doctor deadline exceeded before this server was checked", attempts: 0, skipped: true });
        continue;
      }
      const first = await withDeadline(
        `indexing "${srv.id}"`,
        () => hub.indexServer(srv.id),
        Math.min(attemptBudgetMs(srv), budgetLeft()),
      ).catch((cause: unknown) => ({
        serverId: srv.id,
        indexed: 0,
        error: cause instanceof Error ? cause.message : String(cause),
      }));
      if (first.error && srv.enabled !== false) {
        if (budgetLeft() <= RETRY_SETTLE_MS + 1) {
          indexResults.push({ ...first, attempts: 1 });
          continue;
        }
        await delay(RETRY_SETTLE_MS);
        const retry = await withDeadline(
          `indexing "${srv.id}" (retry)`,
          () => hub.indexServer(srv.id),
          Math.min(attemptBudgetMs(srv), budgetLeft()),
        ).catch((cause: unknown) => ({
          serverId: srv.id,
          indexed: 0,
          error: cause instanceof Error ? cause.message : String(cause),
        }));
        indexResults.push({ ...retry, attempts: 2 });
        continue;
      }
      indexResults.push({ ...first, attempts: 1 });
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
      type HealthRow = { serverId: string; status: string; latencyMs?: number; error?: string; attempts: number };
      const healthResults: HealthRow[] = [];
      for (const srv of enabledServers) {
        if (budgetLeft() <= 0) {
          healthResults.push({ serverId: srv.id, status: "skipped", attempts: 0, error: "global doctor deadline exceeded" });
          continue;
        }
        const first = await withDeadline(
          `health check "${srv.id}"`,
          () => hub.checkHealth(srv.id),
          Math.min(attemptBudgetMs(srv), budgetLeft()),
        ).catch((cause: unknown) => ({
          serverId: srv.id,
          status: "error",
          error: cause instanceof Error ? cause.message : String(cause),
        }));
        if (first.status === "ready" || first.status === "disabled") {
          healthResults.push({ ...first, attempts: 1 });
          continue;
        }
        if (budgetLeft() <= RETRY_SETTLE_MS + 1) {
          healthResults.push({ ...first, attempts: 1 });
          continue;
        }
        await delay(RETRY_SETTLE_MS);
        const second = await withDeadline(
          `health check "${srv.id}" (retry)`,
          () => hub.checkHealth(srv.id),
          Math.min(attemptBudgetMs(srv), budgetLeft()),
        ).catch((cause: unknown) => ({
          serverId: srv.id,
          status: "error",
          error: cause instanceof Error ? cause.message : String(cause),
        }));
        healthResults.push({ ...second, attempts: 2 });
      }
      for (const h of healthResults) {
        const srv = config.servers.find((s) => s.id === h.serverId);
        if (srv?.enabled === false || h.status === "disabled") {
          console.log(`  ℹ [${h.serverId}] intentionally disabled; health probe skipped`);
          continue;
        }
        const attemptNote =
          h.attempts > 1 ? (h.status === "ready" ? " (recovered on retry)" : ` (${h.attempts} attempts)`) : h.status === "skipped" ? " (global deadline)" : "";
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

    result = criticalFailures > 0 ? 1 : 0;
  } finally {
    // Bounded teardown: hub.close() normally ends every anchor (each anchor
    // then kills its wrapper group), but a wedged close must not hang the
    // doctor — the anchor meta files allow exact, reuse-safe tree teardown.
    // Bounded close; the anchored teardown below does not depend on it
    // succeeding — proof comes from each anchor's own exit status.
    const closeBudget = Math.max(2_000, Math.min(10_000, budgetLeft()));
    try {
      await withDeadline("hub.close", () => hub.close(), closeBudget);
    } catch {
      // Bounded: fall through to the anchored teardown below.
    }
    // Every attempt teardown fired at a deadline must be settled and proven.
    await Promise.allSettled(anchorTeardowns);
    // Every anchor still held by the transport that hub.close() terminated:
    // proof is the anchor's OWN exit code (0 = verified cleanup), never a
    // dead-PID inference.
    for (const anchorChild of heldAnchors) {
      if (anchorChild.exitCode === EXIT_PROVEN) continue;
      if (anchorChild.exitCode === null && anchorChild.signalCode === null) {
        const res = await teardownAnchorChild(anchorChild, 5_000);
        if (!res.proven) {
          teardownProven = false;
          teardownSurvivors.push(...res.survivors);
        }
      } else {
        // Exited nonzero/signalled: the anchor itself reported failure.
        teardownProven = false;
      }
    }
    if (teardownSurvivors.length > 0 || !teardownProven) {
      console.error(
        `Doctor teardown failed closed${teardownSurvivors.length > 0 ? ` (surviving PIDs ${teardownSurvivors.join(", ")})` : ""}; treating as a failure.`,
      );
      result = 1;
    }
  }
  return result;
}
