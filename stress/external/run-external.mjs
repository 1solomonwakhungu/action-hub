#!/usr/bin/env node
/**
 * Orchestrator for external stress testing (builder-10, stress/external/).
 *
 * Four-bar compliant (S9-R5):
 *  1. No fixed ports: serve binds port 0; the child's ACTUAL port is parsed
 *     from its own stdout; health is an authenticated initialize against that
 *     child (see serve.mjs).
 *  2. Full ISOLATION.md env for every child (isolation.mjs); the fixture
 *     config is read/copied into the run root before ACTION_HUB_CONFIG is set.
 *  3. Lifecycle: spawn error handlers, drained pipes, process-group kill with
 *     bounded wait + SIGKILL escalation in finally for every child.
 *  4. Contract: every path — including spawn failure and exceptions — writes
 *     the result artifact and prints ONE compact JSON last line with ok:false,
 *     then exits nonzero.
 *
 * 1. Generates the small fixture set (make-fixture.mjs) — or uses an
 *    externally provided config.
 * 2. Starts `action-hub serve` under full isolation, samples its RSS while
 *    load runs.
 * 3. Runs the configured external tools and collects their JSON reports:
 *      - MCP Inspector CLI smoke (both transports)      [always]
 *      - k6 HTTP load                                    [--k6]
 *      - mcp-fuzzer (python venv)                        [--fuzz]
 *      - @hasmcp/mcp-spec-test (npx)                     [--spec]
 *
 * Usage:
 *   node stress/external/run-external.mjs [--config <servers.json>] [--k6] [--k6-full] [--fuzz] [--spec]
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, symlink, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateRuns } from "./verdict.mjs";
import { buildIsolatedEnv, assertFinalEnv } from "./isolation.mjs";
import { startServe, killTree, runTool, foldCleanupVerdict } from "./serve.mjs";
import { main as libMain } from "../lib/harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const genDir = resolve(here, "..", ".generated", "external");
const resultsDir = resolve(here, "..", ".generated", "results");
const K6_BIN = process.env["K6_BIN"] ?? "/tmp/action-hub-stress/bin/k6";

function flag(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] ?? true : undefined;
}
const hasFlag = (name) => process.argv.includes(name);

// Per-run token: proves any HTTP evidence came from a server started with
// THIS run's credentials, not from a stale listener on a reused port.
const token = `stress-external-${Date.now().toString(36)}-${process.pid}`;

/**
 * MIG2: the summary contract is owned by the lib's main() — ONE durable
 * write + ONE stdout JSON + exit code from the FINAL object. finish() just
 * returns the runner's summary; the lib adds totalMs, guards the artifact
 * write, and coordinates interrupts (SIGINT/SIGTERM) with the registry
 * sweep so a mid-run signal kills every owned group and still emits exactly
 * one ok:false summary (exit 143).
 */
async function finish(summary) {
  return summary;
}

async function main() {
  const t0 = Date.now();
  await mkdir(resultsDir, { recursive: true });

  // Full isolation per contract. Fixture inputs (config/skills) may live
  // outside the fresh root but must never be inside owner app state; the
  // sandbox-owned vars must all resolve inside the root.
  const { env: isolatedEnv, root, assertFinal } = buildIsolatedEnv({
    ACTION_HUB_HTTP_TOKEN: token,
    // mcp-fuzzer auth (http target): Authorization: Bearer <token>
    MCP_API_KEY: token,
    MCP_PREFIX: "Bearer",
  });

  const runs = [];
  let serve = null;
  let sampler = null;
  const rssSamples = [];
  let configPath = null;
  let skillsDir = null;
  let healthy = false;

    let serveCleanup = null; // captured kill verdict — folded into ok (MIG2-R1)
  try {
    // 1. Fixture unless an external config is provided. The generator's own
    // summary is validated like every other step: unparsable output or a
    // non-ok summary fails the run (stale fixtures cannot mask a broken
    // generator: it writes a fresh run-<stamp> dir per invocation).
    const externalConfig = flag("--config") && typeof flag("--config") === "string" ? resolve(flag("--config")) : null;
    if (!externalConfig) {
      const gen = runTool("node", [join(here, "make-fixture.mjs")], { env: isolatedEnv, timeoutMs: 120_000 });
      const genRes = await gen.exitP;
      let genSummary = null;
      try {
        genSummary = JSON.parse(genRes.stdoutTail.trim().split("\n").pop() ?? "");
      } catch {
        /* unparsable -> failure below */
      }
      runs.push({
        label: "make-fixture",
        requiresSummary: true,
        exitCode: genRes.code,
        summary: genSummary,
        stdout: genRes.stdoutTail.trim().slice(-2000),
        stderr: genRes.stderrTail.slice(-2000),
      });
      if (genSummary?.outDir) {
        configPath = resolve(genSummary.outDir, "servers.json");
        skillsDir = resolve(genSummary.outDir, "skills");
      }
    } else {
      configPath = externalConfig;
      skillsDir = join(genDir, "skills");
    }

    if (!configPath || !existsSync(configPath)) {
      throw new Error(`config not found: ${configPath}`);
    }

    // Stage the config INTO the run root (reviewer bar 2): the final
    // ACTION_HUB_CONFIG must point inside the fresh root.
    const stagedConfig = join(root, "config", "servers.json");
    await mkdir(join(root, "config"), { recursive: true });
    await copyFile(configPath, stagedConfig);
    configPath = stagedConfig;
    isolatedEnv["ACTION_HUB_CONFIG"] = configPath;
    // Skills dir: symlink inside the root -> fixture dir, so the final var is
    // contained in the root while still exercising the generated fixture.
    const stagedSkills = join(root, "skills");
    // buildIsolatedEnv pre-creates the skills dir; remove it (dir or
    // symlink) before pointing the final var at the fixture.
    await rm(stagedSkills, { recursive: true, force: true });
    if (skillsDir && existsSync(skillsDir)) await symlink(skillsDir, stagedSkills);
    else await mkdir(stagedSkills, { recursive: true });
    isolatedEnv["ACTION_HUB_SKILLS_DIR"] = stagedSkills;
    assertFinal(isolatedEnv);

    // 2. Start serve (port 0, child-attested port, authenticated health).
    serve = await startServe({ configPath, token, skillsDir: stagedSkills, env: isolatedEnv, root, repoRoot });
    healthy = true;

    // RSS sampler for the serve child.
    sampler = setInterval(() => {
      if (!serve?.child?.pid) return;
      try {
        const out = spawnSync("ps", ["-o", "rss=", "-p", String(serve.child.pid)], { encoding: "utf8" });
        const kb = Number(out.stdout.trim());
        if (Number.isFinite(kb) && kb > 0) rssSamples.push({ at: Date.now() - t0, rssKb: kb });
      } catch {
        /* sampler best-effort */
      }
    }, 2000);
    sampler.unref?.();

    // 3a. Inspector smoke (both transports).
    const smoke = runTool("node", [join(here, "inspector-smoke.mjs"), "--config", configPath], {
      env: isolatedEnv, timeoutMs: 300_000,
    });
    const smokeRes = await smoke.exitP;
    let smokeSummary = null;
    try {
      smokeSummary = JSON.parse(smokeRes.stdoutTail.trim().split("\n").pop());
    } catch {
      /* recorded raw */
    }
    runs.push({
      label: "inspector-smoke",
      requiresSummary: true,
      exitCode: smokeRes.code,
      summary: smokeSummary,
      stderr: smokeRes.stderrTail.slice(-2000),
    });

    // 3b. k6 load (async, detached, group-killed on timeout).
    if (hasFlag("--k6")) {
      const profile = hasFlag("--k6-full") ? "full" : "quick";
      const summaryOut = join(resultsDir, "external-k6-summary.json");
      const k6Env = {
        ...isolatedEnv,
        K6_URL: `http://127.0.0.1:${serve.port}`,
        K6_TOKEN: token,
        K6_PROFILE: profile,
      };
      assertFinal(k6Env);
      const k6 = runTool(K6_BIN, ["run", "--summary-export", summaryOut, join(here, "k6-mcp.js")], {
        env: k6Env, timeoutMs: 20 * 60_000,
      });
      const k6Res = await k6.exitP;
      let k6Summary = null;
      try {
        k6Summary = JSON.parse(await readFile(summaryOut, "utf8"));
        k6Summary = { ok: k6Res.code === 0 && !k6Res.timedOut, metrics: k6Summary.metrics ?? {} };
      } catch {
        /* unparsable summary -> row fails via requiresSummary */
      }
      runs.push({
        label: "k6",
        tool: "k6",
        profile,
        requiresSummary: true,
        exitCode: k6Res.code,
        durationMs: k6Res.durationMs,
        summary: k6Summary,
        stderr: k6Res.stderrTail.slice(-3000),
      });
    }

    // 3c. mcp-fuzzer (python venv).
    if (hasFlag("--fuzz")) {
      const f = runTool("node", [join(here, "fuzz.mjs"), "--config", configPath, "--runs", String(process.env["FUZZ_RUNS"] ?? 10)], {
        env: isolatedEnv, timeoutMs: 40 * 60_000,
      });
      const fRes = await f.exitP;
      let fSummary = null;
      try {
        fSummary = JSON.parse(fRes.stdoutTail.trim().split("\n").pop());
      } catch {
        /* recorded raw */
      }
      runs.push({
        label: "mcp-fuzzer",
        requiresSummary: true,
        exitCode: fRes.code,
        durationMs: fRes.durationMs,
        summary: fSummary,
        stderr: fRes.stderrTail.slice(-2000),
      });
    }

    // 3d. @hasmcp/mcp-spec-test (npx).
    if (hasFlag("--spec")) {
      const s = runTool("node", [join(here, "spec-test.mjs"), "--config", configPath], {
        env: isolatedEnv, timeoutMs: 40 * 60_000,
      });
      const sRes = await s.exitP;
      let sSummary = null;
      try {
        sSummary = JSON.parse(sRes.stdoutTail.trim().split("\n").pop());
      } catch {
        /* recorded raw */
      }
      runs.push({
        label: "mcp-spec-test",
        requiresSummary: true,
        exitCode: sRes.code,
        durationMs: sRes.durationMs,
        summary: sSummary,
        stderr: sRes.stderrTail.slice(-2000),
      });
    }
  } catch (cause) {
    runs.push({
      label: "orchestrator-error",
      requiresSummary: true,
      exitCode: 1,
      summary: null,
      error: String(cause?.stack ?? cause).slice(-2000),
    });
  } finally {
    if (sampler) clearInterval(sampler);
    serveCleanup = serve ? await killTree(serve.handle) : null;
  }

  const verdict = aggregateRuns(runs);
  const summary = {
    script: "run-external.mjs",
    configPath,
    servePort: serve?.port ?? null,
    serveChildPid: serve?.child?.pid ?? null,
    healthy,
    runs,
    failures: verdict.failures,
    serveLogTail: serve?.tail?.().slice(-4000) ?? null,
    rssSamples,
    rssPeakKb: rssSamples.length ? Math.max(...rssSamples.map((s) => s.rssKb)) : null,
    durationMs: Date.now() - t0,
    ok: healthy && verdict.ok,
    at: new Date().toISOString(),
  };
  foldCleanupVerdict(summary, serveCleanup, "serve");
  return finish(summary);
}

// MIG2: the orchestration runs under the lib's main() — one guarded region,
// one summary, interrupt-coordinated sweep of every owned group.
await libMain(main, { resultsPath: join(resultsDir, "external.json") });
