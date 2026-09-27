import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { after, before, test } from "node:test";

/**
 * D1 settle-state regression: on a warm-cache start the daemon publishes
 * `indexing: true` while the authoritative post-startup re-index is still
 * running, then rewrites the state file with `indexing: false` +
 * `indexingSettledAt` once it settles. A slow downstream server keeps the
 * reindex in flight long enough to observe both states.
 *
 * (A cold start indexes inside createHubRuntime before the state file is
 * written, so `indexing: true` is only observable on the warm path.)
 */

const DIST_INDEX = fileURLToPath(new URL("../dist/index.js", import.meta.url));

let tmp: string;
let daemonDir: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "daemon-settle-"));
  daemonDir = join(tmp, "daemon");
  mkdirSync(daemonDir, { recursive: true });
});

after(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

// A stdio MCP server that answers the handshake slowly, so the reindex stays
// in flight long enough for the warm start to be observed mid-reindex.
function slowServerScript(): string {
  return [
    "const { createInterface } = require('node:readline');",
    "const rl = createInterface({ input: process.stdin });",
    "rl.on('line', (line) => {",
    "  let msg; try { msg = JSON.parse(line); } catch { return; }",
    "  if (msg.id === undefined) return;",
    "  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');",
    "  if (msg.method === 'initialize') setTimeout(() => reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'slow', version: '0' } }), 700);",
    "  else setTimeout(() => reply(msg.method === 'tools/list' ? { tools: [{ name: 'slow_tool', description: 'slow tool', inputSchema: { type: 'object' } }] } : {}), 100);",
    "});",
  ].join("\n");
}

function daemonEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: tmp,
    XDG_CACHE_HOME: join(tmp, "cache"),
    XDG_CONFIG_HOME: join(tmp, "cfg"),
    ACTION_HUB_DAEMON_DIR: daemonDir,
    ACTION_HUB_CONFIG: join(tmp, "servers.json"),
    ACTION_HUB_SKILLS_DIR: join(tmp, "skills"),
  };
}

async function startDaemon(): Promise<ChildProcess> {
  const daemon = spawn(process.execPath, [DIST_INDEX, "--daemon"], {
    env: daemonEnv(),
    stdio: ["ignore", "ignore", "pipe"],
  });
  // Give the first start time to finish its cold index and warm the cache.
  const statePath = join(daemonDir, "daemon.json");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(50);
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
      if (state["indexing"] === false) break;
    }
  }
  return daemon;
}

test("warm daemon start transitions indexing true -> false with indexingSettledAt", async () => {
  const scriptPath = join(tmp, "slow-server.cjs");
  writeFileSync(scriptPath, slowServerScript(), "utf8");
  writeFileSync(
    join(tmp, "servers.json"),
    JSON.stringify({
      autoDiscover: false,
      servers: [
        {
          id: "slow",
          name: "Slow",
          transport: { type: "stdio", command: process.execPath, args: [scriptPath] },
          trust: "trusted",
        },
      ],
    }),
    "utf8",
  );

  // Phase 1: cold start, warm the cache, then stop.
  const first = await startDaemon();
  first.kill("SIGTERM");
  await new Promise<void>((done) => {
    const timer = setTimeout(done, 5_000);
    first.once("exit", () => {
      clearTimeout(timer);
      done();
    });
  });

  // Phase 2: warm start — the state file must appear with indexing:true while
  // the background re-index of the slow server is still running, then settle.
  // Remove phase-1 leftovers so the poll cannot mistake the previous
  // generation's settled state file for this run's.
  rmSync(join(daemonDir, "daemon.json"), { force: true });
  const second = spawn(process.execPath, [DIST_INDEX, "--daemon"], {
    env: daemonEnv(),
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    let sawIndexingTrue = false;
    let settled: { indexingSettledAt: unknown } | undefined;
    const statePath = join(daemonDir, "daemon.json");
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !(sawIndexingTrue && settled)) {
      await sleep(20);
      if (!existsSync(statePath)) continue;
      let state: Record<string, unknown>;
      try {
        state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (state["indexing"] === true) sawIndexingTrue = true;
      if (state["indexing"] === false && typeof state["indexingSettledAt"] === "string") {
        settled = { indexingSettledAt: state["indexingSettledAt"] };
      }
    }
    assert.ok(sawIndexingTrue, "warm start never showed indexing: true");
    assert.ok(settled, "daemon.json never settled to indexing: false with indexingSettledAt");
    const parsed = new Date(String(settled?.indexingSettledAt));
    assert.equal(Number.isNaN(parsed.getTime()), false, "indexingSettledAt must be an ISO timestamp");
  } finally {
    second.kill("SIGTERM");
    await sleep(200);
  }
});

test("FX12-R5/FX18: a daemon client connecting mid-refresh is served from the warm cache", async () => {
  // Warm start with the slow server: the authoritative re-index stays in
  // flight (700 ms handshake + 100 ms list). A REAL client connects through
  // `action-hub connect` (stdio proxy) mid-refresh and must be served from
  // the warm cache immediately.
  rmSync(join(daemonDir, "daemon.json"), { force: true });
  const daemon = spawn(process.execPath, [DIST_INDEX, "--daemon"], {
    env: daemonEnv(),
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    const statePath = join(daemonDir, "daemon.json");
    let midRefresh = false;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await sleep(20);
      if (!existsSync(statePath)) continue;
      try {
        if ((JSON.parse(readFileSync(statePath, "utf8") as string) as Record<string, unknown>)["indexing"] === true) {
          midRefresh = true;
          break;
        }
      } catch { /* state file mid-write */ }
    }
    assert.ok(midRefresh, "daemon did not publish indexing: true (was the cache warm?)");

    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_INDEX, "connect"],
      env: daemonEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "mid-refresh-probe", version: "0" });
    const connected = performance.now();
    await client.connect(transport);
    // Search DURING the reindex window: answered from the warm cache.
    const start = performance.now();
    const result = await client.callTool({
      name: "action_hub",
      arguments: { operation: "search", query: "slow tool" },
    });
    const latency = performance.now() - start;
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as {
      ok?: boolean;
      count?: number;
      results?: Array<{ id?: string }>;
    };
    assert.equal(payload.ok, true, "search must succeed mid-refresh");
    assert.ok(
      payload.results && payload.results.length > 0,
      `warm-cache hits expected (slow_tool was indexed in the cold phase); got ${JSON.stringify(payload).slice(0, 160)}`,
    );
    assert.ok(
      latency < 2000,
      `mid-refresh search took ${Math.round(latency)}ms — must be served from cache, not blocked on the reindex`,
    );
    void connected;
    await client.close();
  } finally {
    daemon.kill("SIGTERM");
    await sleep(200);
  }
});

test("FX12-R5 rework: the deferred refresh trigger is cancelled by cleanup and guarded after it", async () => {
  const { createDeferredTrigger } = await import("../dist/deferred-trigger.js");
  let started = 0;
  let stopped = false;
  const trigger = createDeferredTrigger(() => stopped);
  // Normal path: one turn later the refresh starts exactly once.
  trigger.schedule(() => {
    started += 1;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 1);
  // Re-scheduling while the callback is pending would be a bug; after it ran, a second schedule starts a second refresh — not our concern here.

  // Shutdown wins the race: schedule, cancel (cleanup), then the captured
  // callback fires anyway — nothing may start.
  stopped = false;
  trigger.schedule(() => {
    started += 1;
  });
  trigger.cancel();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 1, "cancelled trigger must not start the refresh");
  // Even if the queued callback runs after cleanup (the reviewer's race):
  stopped = true;
  trigger.schedule(() => {
    started += 1;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 1, "a callback firing after shutdown must not start the refresh");
});
