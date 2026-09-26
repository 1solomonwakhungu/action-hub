#!/usr/bin/env node
// stress/fake-mcp-server.check.mjs — crash-after concurrency regression
// (committed; NOT under .generated). Uses the real SDK client transports.
//
// Semantics under test (see fake-mcp-server.mjs header): crash-after=N
// counts tools/call requests only. initialize + 4 concurrent 300 ms / 5 MB
// calls with crash-after=3 must yield, over BOTH stdio and HTTP:
//   - 3 full 5 MB successes (no truncated or timed-out response)
//   - 1 immediate isError refusal
//   - the next request disconnected
//   - stderr reports exactly 3 completed tools/call responses
//
// Run: node stress/fake-mcp-server.check.mjs   (from the repo root)

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "fake-mcp-server.mjs");
const EXPECTED_BYTES = Number(process.env.CHECK_BYTES ?? 5_000_000);
const CRASH_AFTER = 3;

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

async function runScenario({ http, port }) {
  const label = http ? "http" : "stdio";
  let child = null;
  let transport;
  if (http) {
    child = spawn("node", [SERVER, "--manifest", manifestPath, "--transport", "http", "--port", String(port), "--chaos", `crash-after=${CRASH_AFTER}`], { stdio: ["ignore", "ignore", "pipe"] });
    let stderrText = "";
    child.stderr.on("data", (c) => { stderrText += String(c); });
    await new Promise((r) => setTimeout(r, 700));
    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    var stderrRef = () => stderrText;
  } else {
    transport = new StdioClientTransport({
      command: "node",
      args: [SERVER, "--manifest", manifestPath, "--chaos", `crash-after=${CRASH_AFTER}`],
      stderr: "pipe",
    });
    let stderrText = "";
    transport.stderr?.on?.("data", (c) => { stderrText += String(c); });
    var stderrRef = () => stderrText;
  }

  const client = new Client({ name: "crash-check", version: "0.0.0" });
  try {
    await client.connect(transport);
    // 4 concurrent calls, crash-after=3: exactly 3 accepted + 1 refusal.
    const results = await Promise.allSettled(
      [0, 1, 2, 3].map((i) => client.callTool({ name: "echo", arguments: { x: i } })),
    );
    const full = results.filter(
      (r) => r.status === "fulfilled" && r.value?.isError !== true &&
        JSON.parse(r.value.content[0].text).filler.length === EXPECTED_BYTES,
    );
    const refused = results.filter((r) => r.status === "fulfilled" && r.value?.isError === true);
    const errored = results.filter((r) => r.status === "rejected");
    if (errored.length > 0) {
      for (const e of errored) process.stdout.write(`DEBUG ${label} error: ${String(e.reason).slice(0, 120)}\n`);
    }
    check(`${label}: 3 full ${EXPECTED_BYTES}-byte successes`, full.length === 3, `got ${full.length}`);
    check(`${label}: 1 isError refusal`, refused.length === 1, `got ${refused.length}, errors ${errored.length}`);
    check(`${label}: no truncated/timed-out results`, full.length + refused.length + errored.length === 4, `full=${full.length} refused=${refused.length} errored=${errored.length}`);

    // Refused response must NOT count: stderr must say exactly 3.
    await new Promise((r) => setTimeout(r, 800));
    const m = stderrRef().match(/crash-after=\d+ triggered after (\d+) completed tools\/call responses/);
    check(`${label}: log reports exactly ${CRASH_AFTER}`, m?.[1] === String(CRASH_AFTER), m?.[0] ?? "no crash log line");

    // Next request after the crash: disconnected.
    try {
      await client.callTool({ name: "echo", arguments: { x: 9 } });
      check(`${label}: post-crash call rejected`, false, "unexpectedly succeeded");
    } catch {
      check(`${label}: post-crash call rejected`, true);
    }
  } finally {
    await client.close().catch(() => {});
    if (child) child.kill("SIGKILL");
  }
}

const port = 41390;
await runScenario({ http: false });
await runScenario({ http: true, port });

process.stdout.write(failures === 0 ? "ALL CHECKS PASSED\n" : `${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
