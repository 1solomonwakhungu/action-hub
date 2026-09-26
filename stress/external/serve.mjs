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
import { spawn } from "node:child_process";
import { isAbsolute, join, relative } from "node:path";

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
  const child = spawn(process.execPath, [binary, "serve", "--config", configPath, "--port", "0"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group so cleanup can kill the whole tree
  });

  let spawnError = null;
  child.on("error", (cause) => { spawnError = cause; });
  let tail = "";
  let sawPort = null;
  let sawTokenLine = false;
  const portWaiters = [];
  const notifyPort = () => { while (portWaiters.length) portWaiters.shift()(sawPort); };
  for (const stream of [child.stdout, child.stderr]) {
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
  const exitP = new Promise((resolveExit) => {
    child.on("close", (code, signal) => {
      exitInfo = { code, signal };
      resolveExit(exitInfo);
    });
  });

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
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`serve exited before health check; tail=${tail.slice(-400)}`);
  }
  if (!sawTokenLine) {
    throw new Error(`serve did not confirm bearer-token auth; tail=${tail.slice(-400)}`);
  }
  let healthy = false;
  const healthDeadline = Date.now() + startTimeoutMs;
  while (Date.now() < healthDeadline && !exitInfo) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stress", version: "0" } } }),
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
    await killTree(child, exitP);
    throw new Error(`serve on port ${port} (from its own stdout) never answered an authenticated initialize; tail=${tail.slice(-400)}`);
  }

  return {
    child,
    port,
    env,
    root,
    /** Resolves with {code, signal} when the child closes. */
    exitP,
    /** Tail of the child's stdout+stderr for evidence. */
    tail: () => tail,
  };
}

/**
 * Terminates a detached child's whole process group: SIGTERM, bounded wait,
 * then SIGKILL escalation. Resolves when the group is gone.
 */
export async function killTree(child, exitP, graceMs = 5_000) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return null;
  const sig = (s) => {
    try { process.kill(-child.pid, s); } catch { /* already gone */ }
    try { child.kill(s); } catch { /* already gone */ }
  };
  sig("SIGTERM");
  const result = await Promise.race([
    exitP ?? new Promise(() => undefined),
    new Promise((resolveKill) => setTimeout(() => {
      sig("SIGKILL");
      resolveKill({ code: null, signal: "SIGKILL" });
    }, graceMs)),
  ]);
  // Give the KILL a moment to reap.
  await Promise.race([
    exitP ?? Promise.resolve(null),
    new Promise((r) => setTimeout(r, 1_000)),
  ]);
  return result ?? null;
}

/** Separator-safe containment check (path.relative, no string prefixes). */
export function isInside(root, candidate) {
  const rel = relative(resolve(root), resolve(String(candidate)));
  return rel === "" || (!isAbsolute(rel) && !rel.split(/[\\/]/).includes(".."));
}

/**
 * Runs an external tool as a detached process with full pipe draining, a
 * hard timeout, and process-group kill. Collects {code, stdoutTail,
 * stderrTail, durationMs}. Use this instead of spawnSync so timed-out runs
 * cannot leak descendants.
 */
export function runTool(cmd, args, { env, timeoutMs = 30 * 60_000, killOnTimeout = true } = {}) {
  const started = Date.now();
  const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let spawnError = null;
  child.on("error", (cause) => { spawnError = cause; });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout = (stdout + chunk).slice(-200_000); });
  child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-200_000); });
  let timedOut = false;
  const exitP = new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      timedOut = true;
      if (killOnTimeout) void killTree(child, new Promise((res) => child.on("close", (c, s) => res({ code: c, signal: s }))), 5_000);
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal, timedOut });
    });
  });
  return {
    exitP: exitP.then((r) => ({
      code: spawnError ? -1 : (r?.code ?? null),
      signal: r?.signal ?? null,
      timedOut: r?.timedOut ?? timedOut,
      stdoutTail: stdout.slice(-20_000),
      stderrTail: stderr.slice(-20_000),
      durationMs: Date.now() - started,
      spawnError: spawnError ? String(spawnError) : null,
    })),
    child,
  };
}
