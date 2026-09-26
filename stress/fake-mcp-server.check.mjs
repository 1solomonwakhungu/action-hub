#!/usr/bin/env node
// stress/fake-mcp-server.check.mjs — crash-after regression suite
// (committed; NOT under .generated). Uses the real SDK client transports.
//
// Contract under test (see fake-mcp-server.mjs header): crash-after=N
// counts tools/call requests ONLY; ids are client-scoped; accepted calls
// settle as finished (fully delivered) or aborted; exit + log occur exactly
// once once all N accepted calls have settled; refusals never count.
//
// Cases (every wait bounded — the suite FAILS rather than hangs):
//   1. stdio:  initialize + 4 concurrent 300 ms / 5 MB calls, crash-after=3
//      -> 3 full successes, 1 refusal, log completed=3 aborted=0, next call rejected
//   2. http:   same shape over StreamableHTTPClientTransport (ephemeral port)
//   3. http:   TWO concurrent clients each issuing their FIRST tools/call
//      with crash-after=2 (same JSON-RPC id on both connections)
//      -> 2 full successes, server exits, log completed=2 aborted=0
//
// Run: node stress/fake-mcp-server.check.mjs   (from the repo root)

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { connect as tcpConnect } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "fake-mcp-server.mjs");
const EXPECTED_BYTES = 5_000_000;
const STEP_TIMEOUT_MS = 30_000; // generous; only guards against hangs

const manifestDir = mkdtempSync(join(tmpdir(), "fake-mcp-check-"));
const manifestPath = join(manifestDir, "manifest.json");
writeFileSync(
  manifestPath,
  JSON.stringify({
    serverId: "check",
    tools: [{
      name: "echo",
      description: "echo probe",
      inputSchema: { type: "object", properties: { x: { type: "number" } } },
      annotations: { readOnlyHint: true },
      behavior: { latencyMs: 300, responseBytes: EXPECTED_BYTES },
    }],
  }),
);
process.on("exit", () => rmSync(manifestDir, { recursive: true, force: true }));

let failures = 0;
function check(name, ok, detail = "") {
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}\n`);
  if (!ok) failures += 1;
}

// Poll until the server accepts TCP connections (bounded); a plain socket
// touch, not an MCP request, so it consumes no JSON-RPC calls.
async function waitForTcp(port, label, timeoutMs = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const up = await new Promise((resolve) => {
      const sock = tcpConnect(port, "127.0.0.1");
      sock.once("connect", () => { sock.destroy(); resolve(true); });
      sock.once("error", () => resolve(false));
    });
    if (up) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server not listening in time: ${label}`);
}

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`deadline exceeded: ${label}`)), STEP_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function collectStderr(stream) {
  let text = "";
  stream?.on?.("data", (c) => { text += String(c); });
  return () => text;
}

function parseCrashLog(stderrText) {
  const m = stderrText.match(/crash-after=\d+ triggered: completed=(\d+) aborted=(\d+)/);
  return m ? { completed: Number(m[1]), aborted: Number(m[2]) } : null;
}

async function runSingleClient({ http, port, existingChild = null, existingStderr = null }) {
  const label = http ? "http" : "stdio";
  let child = existingChild;
  let stderrText = existingStderr;
  let transport;
  if (http) {
    await withTimeout(waitForTcp(port, `http boot :${port}`), "http server boot");
    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  } else {
    transport = new StdioClientTransport({
      command: "node",
      args: [SERVER, "--manifest", manifestPath, "--chaos", "crash-after=3"],
      stderr: "pipe",
    });
    const collect = await collectStderr(transport.stderr);
    stderrText = collect;
  }
  const getStderr = typeof stderrText === "function" ? stderrText : () => stderrText;

  const client = new Client({ name: "crash-check", version: "0.0.0" });
  try {
    await withTimeout(client.connect(transport), `${label}: connect`);
    const results = await withTimeout(
      Promise.allSettled([0, 1, 2, 3].map((i) => client.callTool({ name: "echo", arguments: { x: i } }))),
      `${label}: 4 concurrent calls`,
    );
    const full = results.filter(
      (r) => r.status === "fulfilled" && r.value?.isError !== true &&
        JSON.parse(r.value.content[0].text).filler.length === EXPECTED_BYTES,
    );
    const refused = results.filter((r) => r.status === "fulfilled" && r.value?.isError === true);
    const errored = results.filter((r) => r.status === "rejected");
    check(`${label}: 3 full ${EXPECTED_BYTES}-byte successes`, full.length === 3, `got ${full.length}, errors ${errored.length}: ${errored.map((e) => String(e.reason).slice(0, 60)).join(" | ")}`);
    check(`${label}: 1 isError refusal`, refused.length === 1, `got ${refused.length}`);
    check(`${label}: no truncated/timed-out results`, full.length + refused.length + errored.length === 4);

    await withTimeout(new Promise((r) => setTimeout(r, 800)), `${label}: log wait`);
    const log = parseCrashLog(getStderr());
    check(`${label}: log completed=3 aborted=0`, log?.completed === 3 && log?.aborted === 0, JSON.stringify(log));

    try {
      await withTimeout(client.callTool({ name: "echo", arguments: { x: 9 } }), `${label}: post-crash call`);
      check(`${label}: post-crash call rejected`, false, "unexpectedly succeeded");
    } catch {
      check(`${label}: post-crash call rejected`, true);
    }
  } catch (e) {
    check(`${label}: scenario completed`, false, String(e).slice(0, 120));
  } finally {
    await client.close().catch(() => {});
    if (child) child.kill("SIGKILL");
  }
}

async function runTwoClientCollision({ port, getStderr, child }) {
  await withTimeout(waitForTcp(port, `two-client boot :${port}`), "two-client server boot");
  try {
    const transports = [0, 1].map(() => new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    const clients = transports.map((t) => new Client({ name: "collision-check", version: "0.0.0" }));
    await withTimeout(Promise.all(clients.map((c, i) => c.connect(transports[i]))), "two-client connect");
    // Both clients issue their FIRST tools/call concurrently — same JSON-RPC
    // id (1) on both connections. State must be scoped per connection.
    const results = await withTimeout(
      Promise.allSettled(clients.map((c) => c.callTool({ name: "echo", arguments: { x: 0 } }))),
      "two-client concurrent first calls",
    );
    const full = results.filter(
      (r) => r.status === "fulfilled" && r.value?.isError !== true &&
        JSON.parse(r.value.content[0].text).filler.length === EXPECTED_BYTES,
    );
    check("two-client: both first calls fully delivered", full.length === 2, `got ${full.length}: ${results.map((r) => r.status === "fulfilled" ? (r.value.isError ? "refused" : "ok") : String(r.reason).slice(0, 50)).join(",")}`);

    await withTimeout(new Promise((r) => setTimeout(r, 1_000)), "two-client log wait");
    const log = parseCrashLog(getStderr());
    check("two-client: log completed=2 aborted=0 (exact)", log?.completed === 2 && log?.aborted === 0, JSON.stringify(log));

    // Server must have exited once both calls settled.
    const exited = await withTimeout(
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
        child.once("exit", () => resolve(true));
        setTimeout(() => resolve(false), 5_000);
      }),
      "two-client exit wait",
    );
    check("two-client: server exited after both settled", exited === true);
  } catch (e) {
    check("two-client: scenario completed", false, String(e).slice(0, 120));
  } finally {
    child.kill("SIGKILL");
  }
}

// Early-abort: a raw HTTP client that destroys the request as soon as the
// response HEADERS arrive (before the delayed 5 MB body). The accepted call
// must settle as aborted (completed=0 aborted=1) and the process must exit.
async function runEarlyAbort({ port, getStderr, child }) {
  await withTimeout(waitForTcp(port, `early-abort boot :${port}`), "early-abort server boot");
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: {} } });
    const ac = new AbortController();
    const t0 = Date.now();
    let sawHeaders = false;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body,
        signal: ac.signal,
      });
      sawHeaders = true;
      ac.abort(); // destroy as soon as headers arrive, before the 5 MB body
      await res.text().catch(() => {});
    } catch {
      // abort may surface as a fetch rejection — fine
    }
    check("early-abort: response headers arrived before destroy", sawHeaders);

    await withTimeout(
      new Promise((resolve, reject) => {
        const poll = setInterval(() => {
          const log = parseCrashLog(getStderr());
          if (log) { clearInterval(poll); resolve(log); }
        }, 100);
        setTimeout(() => { clearInterval(poll); reject(new Error("no settled crash log within deadline")); }, STEP_TIMEOUT_MS);
      }),
      "early-abort settle wait",
    ).then(
      (log) => check("early-abort: log completed=0 aborted=1", log?.completed === 0 && log?.aborted === 1, JSON.stringify(log)),
      (e) => check("early-abort: log completed=0 aborted=1", false, String(e).slice(0, 80)),
    );

    const exited = await withTimeout(
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
        child.once("exit", () => resolve(true));
        setTimeout(() => resolve(false), STEP_TIMEOUT_MS);
      }),
      "early-abort exit wait",
    );
    check("early-abort: server process exited", exited === true);
    process.stdout.write(`early-abort: settled after ${Date.now() - t0}ms\n`);
  } catch (e) {
    check("early-abort: scenario completed", false, String(e).slice(0, 120));
  }
}

// Each live test server owns its own port-0 allocation: spawn with
// --port 0, then read the ACTUAL port from that same child's log line.
async function spawnEphemeralServer(chaos) {
  const child = spawn("node", [SERVER, "--manifest", manifestPath, "--transport", "http", "--port", "0", "--chaos", chaos], { stdio: ["ignore", "ignore", "pipe"] });
  const getStderr = await collectStderr(child.stderr);
  let port = null;
  await withTimeout((async () => {
    while (port === null) {
      const m = getStderr().match(/listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/);
      if (m) port = Number(m[1]);
      else await new Promise((r) => setTimeout(r, 100));
    }
  })(), "ephemeral port discovery");
  return { child, getStderr, port };
}

await runSingleClient({ http: false });
{
  const { child, getStderr, port } = await spawnEphemeralServer("crash-after=3");
  try {
    await runSingleClient({ http: true, port, existingChild: child, existingStderr: getStderr });
  } finally {
    child.kill("SIGKILL");
  }
}
{
  const { child, getStderr, port } = await spawnEphemeralServer("crash-after=2");
  try {
    await runTwoClientCollision({ port, getStderr, child });
  } finally {
    child.kill("SIGKILL");
  }
}
{
  const { child, getStderr, port } = await spawnEphemeralServer("crash-after=1");
  try {
    await runEarlyAbort({ port, getStderr, child });
  } finally {
    child.kill("SIGKILL");
  }
}

process.stdout.write(failures === 0 ? "ALL CHECKS PASSED\n" : `${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
