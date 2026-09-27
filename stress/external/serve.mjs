/**
 * Shared serve lifecycle for external stress runners (builder-10).
 *
 * Satisfies the four-bar rework (S9-R5):
 *  - port 0 + parse the child's ACTUAL port from its own stdout;
 *  - health proven to belong to THAT child: the port comes from the child's
 *    stdout (with the per-run bearer token presented), and the child is
 *    confirmed alive and its pipes are drained;
 *  - early-exit monitoring, spawn error handlers;
 *  - process-group termination with bounded wait and SIGKILL escalation.
 */
import { isAbsolute, join, resolve } from "node:path";
import { spawnGroup, killGroupAndVerify, runStep, pathContains } from "../lib/harness.mjs";

const here = new URL(".", import.meta.url).pathname;

/** Parses the actual listen port from `serve --port 0` stdout. */
export function parseServePort(text) {
  const match = String(text).match(/listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/);
  return match ? Number(match[1]) : null;
}

/**
 * Starts an isolated `action-hub serve` bound to port 0.
 * @param {object} opts
 * @param {string} opts.configPath  fixture config (a run input)
 * @param {string} opts.token       per-run bearer token
 * @param {string} opts.skillsDir   fixture skills dir (a run input)
 * @param {object} [opts.extraEnv]  additional env (already validated)
 * @param {string} [opts.binary]    serve entry; defaults to <repoRoot>/packages/cli/dist/index.js
 * @param {number} [opts.startTimeoutMs]
 * @param {string} [opts.repoRoot]  repo root for the default binary
 */
export async function startServe({
  configPath,
  token,
  skillsDir,
  extraEnv = {},
  /**
   * Prebuilt isolated env (recommended: the orchestrator's ONE env). When
   * omitted, a fresh isolated env is built here.
   */
  env: providedEnv,
  root: providedRoot,
  startTimeoutMs = 60_000,
  repoRoot,
}) {
  let env = providedEnv;
  let root = providedRoot;
  if (!env) {
    const { buildIsolatedEnv } = await import("./isolation.mjs");
    const built = buildIsolatedEnv({
      ACTION_HUB_CONFIG: configPath,
      ACTION_HUB_SKILLS_DIR: skillsDir,
      ACTION_HUB_HTTP_TOKEN: token,
      ...extraEnv,
    });
    env = built.env;
    root = built.root;
  } else {
    env = { ...env, ACTION_HUB_HTTP_TOKEN: env["ACTION_HUB_HTTP_TOKEN"] ?? token, ...extraEnv };
  }
  const binary = process.env["ACTION_HUB_SERVE_BIN"] ?? join(repoRoot ?? resolve(here, "..", ".."), "packages", "cli", "dist", "index.js");
  // MIG2: the serve child runs as a NON-detached workload inside a dedicated
  // detached anchor's process group (Design C). The anchor is the
  // always-live ownership proof; the lib's kill ladder gates every
  // negative-pgid signal on that proof, so a wedged serve can never leave a
  // leaderless group behind.
  const handle = await spawnGroup(
    process.execPath,
    [binary, "serve", "--config", configPath, "--port", "0"],
    { env, cwd: process.cwd() },
  );
  let spawnError = null;
  let tail = "";
  let sawPort = null;
  let sawTokenLine = false;
  const portWaiters = [];
  const notifyPort = () => { while (portWaiters.length) portWaiters.shift()(sawPort); };
  for (const stream of [handle.stdout, handle.stderr]) {
    stream?.on("data", (chunk) => {
      tail = (tail + String(chunk)).slice(-20_000);
      const parsed = parseServePort(tail);
      if (parsed && !sawPort) {
        sawPort = parsed;
        notifyPort();
      }
      if (tail.includes("bearer token: from ACTION_HUB_HTTP_TOKEN")) sawTokenLine = true;
    });
  }
  let exitInfo = null;
  const exitP = handle.exited.then((e) => {
    exitInfo = { code: e?.code ?? null, signal: e?.signal ?? null, anchorDied: e?.anchorDied === true, error: e?.error ?? null };
    return exitInfo;
  });

  // Every failure after spawn must clean up the child we own.
  try {
    // Wait for the child to report its actual port; fail fast on early exit.
    const port = await new Promise((resolvePort, rejectPort) => {
      portWaiters.push(resolvePort);
      if (sawPort) notifyPort();
      const timer = setTimeout(() => rejectPort(new Error(`serve did not report a port in ${startTimeoutMs}ms; tail=${tail.slice(-400)}`)), startTimeoutMs);
      const poll = setInterval(() => {
        if (spawnError) {
          clearTimeout(timer); clearInterval(poll);
          rejectPort(new Error(`serve spawn error: ${spawnError}`));
        }
        if (exitInfo) {
          clearTimeout(timer); clearInterval(poll);
          rejectPort(new Error(`serve exited early code=${exitInfo.code} signal=${exitInfo.signal}; tail=${tail.slice(-400)}`));
        }
      }, 100);
      portWaiters.push((value) => { clearTimeout(timer); clearInterval(poll); resolvePort(value); });
    });

    // Prove the /health endpoint belongs to THIS child: the port was parsed
    // from this child's own stdout, the child is still alive, and the banner
    // confirms it authenticated with this run's token.
    try {
      process.kill(handle.pid, 0); // liveness probe on the WORKLOAD pid
    } catch {
      throw new Error(`serve exited before health check; tail=${tail.slice(-400)}`);
    }
    if (!sawTokenLine) {
      throw new Error(`serve did not confirm bearer-token auth; tail=${tail.slice(-400)}`);
    }
    let healthy = false;
    const healthDeadline = Date.now() + startTimeoutMs;
    while (Date.now() < healthDeadline && !exitInfo) {
      try {
        // AbortSignal bounds each probe so a wedged socket cannot hang startup.
        const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stress", version: "0" } } }),
          signal: AbortSignal.timeout(5_000),
        });
        // The endpoint may answer application/json or an SSE stream; parse both.
        const text = await res.text();
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {
          for (const line of text.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              body = JSON.parse(line.slice(5).trim());
              break;
            } catch {
              /* keep scanning */
            }
          }
        }
        if (res.status === 200 && body?.result?.serverInfo) { healthy = true; break; }
      } catch {
        /* not accepting yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!healthy) {
      throw new Error(`serve on port ${port} (from its own stdout) never answered an authenticated initialize; tail=${tail.slice(-400)}`);
    }
    return {
      /** The lib group handle: {pid, pgid, anchor, exited, ...}. Kills go
       * through THIS (object identity is the ownership proof). */
      handle,
      /** Workload pid (shape-compat: old callers read serve.child.pid). */
      pid: handle.pid,
      child: { pid: handle.pid },
      port,
      env,
      root,
      /** Resolves with {code, signal, anchorDied, error} when the workload
       * closes (anchor death is surfaced as anchorDied, never adopted as the
       * workload's result). */
      exitP,
      /** Tail of the child's stdout+stderr for evidence. */
      tail: () => tail,
    };
  } catch (cause) {
    await killGroupAndVerify(handle);
    throw cause;
  }
}

/**
 * Fail-closed fold of a cleanup verdict into a runner summary (reviewer
 * MIG2-R1): groupEmpty !== true, a killError, or ANY survivor evidence makes
 * the summary NOT ok — a successful workload with failed cleanup can never
 * pass. Returns the mutated summary; evidence lands in summary.cleanupFailures.
 */
export function foldCleanupVerdict(summary, verdict, label = "cleanup") {
  if (!verdict) return summary;
  const problems = [];
  if (verdict.groupEmpty !== true) problems.push(`groupEmpty !== true (${JSON.stringify(verdict.groupEmpty)})`);
  if (verdict.error) problems.push(`error: ${String(verdict.error).slice(0, 300)}`);
  if (verdict.killError) problems.push(`killError: ${String(verdict.killError).slice(0, 300)}`);
  const survivors = Array.isArray(verdict.survivors) ? verdict.survivors : [];
  if (survivors.length > 0) problems.push(`survivors: ${JSON.stringify(survivors).slice(0, 300)}`);
  if (problems.length > 0) {
    summary.ok = false;
    summary.cleanupFailures = [...(summary.cleanupFailures ?? []), { label, problems }];
  }
  return summary;
}

/**
 * Terminates a served group via the lib's gated ladder (MIG2): TERM ->
 * bounded wait -> FINAL KILL -> verify, every negative-pgid signal gated on
 * the exact anchor being provably ours and alive immediately before it
 * fires. Resolves {groupEmpty, survivors, error?} — a FALSE green is
 * impossible: a failed verification is reported as such, never folded into
 * success.
 */
export async function killTree(target) {
  if (!target) return null;
  return killGroupAndVerify(target);
}

/** Separator-safe containment check (path.relative, no string prefixes). */
export function isInside(root, candidate) {
  // Delegated to the lib (MIG2): path.relative-based, separator-safe.
  return pathContains(root, candidate);
}

/**
 * Runs an external tool as a detached process with full pipe draining, a
 * hard timeout, and process-group kill. Collects {code, stdoutTail,
 * stderrTail, durationMs}. Use this instead of spawnSync so timed-out runs
 * cannot leak descendants.
 */
export function runTool(cmd, args, { env, timeoutMs = 30 * 60_000, win32, taskkillRunner } = {}) {
  // MIG2: one anchored, drained, bounded step through the lib. The group is
  // reaped on EVERY completion path (timeout -> TERM -> FINAL KILL ->
  // verify; successful-launcher stragglers reaped too). Keep this
  // SYNCHRONOUS — runners do `const t = runTool(...); await t.exitP`.
  const started = Date.now();
  const stepP = runStep(cmd, args, { env, timeoutMs, win32, taskkillRunner });
  return {
    exitP: stepP.then((r) => ({
      code: r.pid === null && r.error ? -1 : r.code,
      signal: r.signal ?? null,
      timedOut: r.timedOut === true,
      stdoutTail: String(r.stdout ?? "").slice(-20_000),
      stderrTail: String(r.stderr ?? "").slice(-20_000),
      durationMs: Date.now() - started,
      spawnError: r.error ?? null,
      // Truthful teardown evidence from the lib (never folded away):
      groupEmpty: r.groupEmpty,
      survivors: r.survivors ?? [],
      killError: r.killError ?? null,
      // The anchored pgid for follow-up cleanup through the authoritative
      // handle (registeredHandleFor) when a verdict is non-green.
      pgid: r.pgid ?? null,
    })),
  };
}
