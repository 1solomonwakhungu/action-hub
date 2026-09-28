// F16/FX6-R4: Streamable HTTP transport failures through the REAL adapter.
// 1) A stopped HTTP server opens the breaker via the fetch-failure cause chain.
// 2) A LIVE server whose tool throws McpError(-32000, "Connection closed")
//    must NEVER open the breaker (code/message-only inference is wrong).
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ServerConfig } from "@action-hub/core";
import { createSdkClientFactory } from "../dist/client-factory.js";
import { testActionHub } from "./test-hub.ts";

const HERE = import.meta.dirname;
const REPO = resolve(HERE, "..", "..", "..");
const SERVER = resolve(HERE, "fixtures", "f16-http-server.mjs");

function startHttpServer(mode: string, scratch: string): { url: string; kill: () => void } {
  const portFile = resolve(scratch, `port-${mode}-${Math.random().toString(36).slice(2)}`);
  const pidFile = resolve(scratch, `pid-${mode}-${Math.random().toString(36).slice(2)}`);
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, F16_HTTP_MODE: mode, F16_HTTP_PORT: "0", F16_HTTP_ADDR_FILE: portFile, HTTP_PID_FILE: pidFile },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 100; i++) {
    if (existsyncSafe(portFile)) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  const port = Number(readFileSync(portFile, "utf8"));
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    kill: () => child.kill(),
  };
}
function existsyncSafe(p: string): boolean {
  try { readFileSync(p); return true; } catch { return false; }
}

function makeHttpHub(url: string, threshold = 3) {
  const config: ServerConfig = {
    id: "httpx",
    transport: { type: "http", url },
    trust: "trusted",
  };
  return testActionHub({
    servers: [config],
    clientFactory: createSdkClientFactory(),
    resilience: { failureThreshold: threshold, cooldownMs: 3_000, heartbeat: { enabled: false } },
    defaultTimeoutMs: 5_000,
  });
}

test("a stopped Streamable HTTP server opens the breaker via the fetch-failure cause chain", async () => {
  const scratch = mkdtempSync(`${tmpdir()}/f16http-`);
  const server = startHttpServer("ok", scratch);
  const hub = makeHttpHub(server.url);
  try {
    const results = await hub.indexAll();
    assert.equal(results[0]!.indexed, 1, "healthy HTTP server indexed");
    server.kill(); // listener gone; transport was never closed from the client side
    await new Promise((r) => setTimeout(r, 100));
    let opened = false;
    for (let i = 0; i < 6; i++) {
      await hub.execute("httpx:send_message", {}).catch(() => {});
      if (hub.serverStates()[0]!.circuitState === "open") { opened = true; break; }
    }
    assert.equal(opened, true, "fetch-failed connection errors must reach the breaker");
    const [state] = hub.serverStates();
    assert.ok(state!.consecutiveFailures >= 3);
  } finally {
    await hub.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("request-socket drop with the listener up opens the breaker via UND_ERR_SOCKET", async () => {
  const scratch = mkdtempSync(`${tmpdir()}/f16http-`);
  const server = startHttpServer("drop", scratch);
  const hub = makeHttpHub(server.url);
  try {
    const results = await hub.indexAll();
    assert.equal(results[0]!.indexed, 1, "indexed while the listener is up");
    // Every tools/call socket is destroyed server-side: undici rejects with
    // TypeError("fetch failed") -> SocketError("other side closed",
    // code="UND_ERR_SOCKET"). The listener itself stays up.
    const second = await hub.execute("httpx:send_message", {});
    assert.equal(second.ok, false);
    let s1 = hub.serverStates()[0]!;
    assert.equal(s1.circuitState, "closed");
    assert.equal(s1.consecutiveFailures, 1, "UND_ERR_SOCKET cause chain counts as failure 1");
    await hub.execute("httpx:send_message", {});
    assert.equal(hub.serverStates()[0]!.consecutiveFailures, 2);
    await hub.execute("httpx:send_message", {});
    const s3 = hub.serverStates()[0]!;
    assert.equal(s3.circuitState, "open", "breaker opens on exactly the 3rd consecutive socket drop");
    assert.equal(s3.consecutiveFailures, 3);
  } finally {
    await hub.close();
    server.kill();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a live server throwing McpError(-32000, 'Connection closed') never opens the breaker", async () => {
  const scratch = mkdtempSync(`${tmpdir()}/f16http-`);
  const server = startHttpServer("mcp32000", scratch);
  const hub = makeHttpHub(server.url);
  try {
    const results = await hub.indexAll();
    assert.equal(results[0]!.indexed, 1);
    for (let i = 0; i < 5; i++) {
      const r = await hub.execute("httpx:send_message", {});
      assert.equal(r.ok, false);
    }
    const [state] = hub.serverStates();
    assert.equal(state!.circuitState, "closed", "coded tool errors from a live server must not trip the breaker");
    assert.equal(state!.consecutiveFailures, 0);
  } finally {
    await hub.close();
    server.kill();
    rmSync(scratch, { recursive: true, force: true });
  }
});
