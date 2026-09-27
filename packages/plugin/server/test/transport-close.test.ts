// F26 rework coverage for the plugin adapter: the client wrapper's close()
// must close the TRANSPORT first. A hanging in-flight tools/call can stall
// client.close(); if it ran first, transport.close would never be reached
// and the spawned stdio child would leak.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createSdkClientFactory } from "../dist/sdk-client.js";
import type { ServerConfig } from "@action-hub/core";

const SERVER_SCRIPT = resolve(import.meta.dirname, "fixtures", "f26-server.mjs");
const REPO = resolve(import.meta.dirname, "..", "..", "..", "..");

test("plugin adapter: hung in-flight call, transport closes first, child reaped", async () => {
  const scratch = mkdtempSync(`${tmpdir()}/f26p-`);
  const pidFile = resolve(scratch, "pid");
  const config: ServerConfig = {
    id: "f26p",
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [SERVER_SCRIPT],
      cwd: REPO,
      env: { F26_PID_FILE: pidFile },
    },
    trust: "trusted",
  };
  const factory = createSdkClientFactory();
  const client = await factory(config, {});
  try {
    const tools = await client.listTools();
    assert.equal(tools.length, 1);
    // In-flight hanging call: the wrapper close must not depend on it.
    const hung = client.callTool("slow_tool", {}).catch(() => "rejected");
    const closePromise = client.close(); // must not wait on the hung call
    const closed = await Promise.race([
      closePromise.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 3_000)),
    ]);
    assert.equal(closed, true, "transport-first close must finish promptly despite the hung call");
    void closePromise.catch(() => {});
    void hung.catch(() => {});
  } finally {
    // Reap check.
    const deadline = Date.now() + 8_000;
    let reaped = false;
    while (Date.now() < deadline) {
      try {
        const pid = Number(readFileSync(pidFile, "utf8"));
        process.kill(pid, 0);
      } catch {
        reaped = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(reaped, true, "spawned child must be reaped by the transport-first close");
  }
  rmSync(scratch, { recursive: true, force: true });
});
