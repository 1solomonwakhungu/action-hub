// F27 end-to-end through the REAL createSdkClientFactory adapter: a stdio
// child that never answers initialize must not gate indexAll beyond its
// deadline, and the spawned child must be gone afterwards.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { ActionHub, type ServerConfig } from "@action-hub/core";
import { createSdkClientFactory } from "../dist/client-factory.js";

const HERE = import.meta.dirname;
const REPO = resolve(HERE, "..", "..", "..");

test("never-initializing stdio child: indexAll completes at the deadline, child reaped", async () => {
  const scratch = mkdtempSync(`${tmpdir()}/f27-`);
  const pidFile = resolve(scratch, "pid");
  const deadConfig: ServerConfig = {
    id: "dead",
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [resolve(HERE, "fixtures", "f16-hang-server.mjs")],
      cwd: REPO,
      env: { F16_PID_FILE: pidFile },
    },
    trust: "trusted",
    timeoutMs: 1_000,
  };
  const liveConfig: ServerConfig = {
    id: "f16",
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [resolve(HERE, "fixtures", "f16-server.mjs")],
      cwd: REPO,
      env: { F16_MODE: "ok_then_exit" },
    },
    trust: "trusted",
  };
  const hub = new ActionHub({
    servers: [deadConfig, liveConfig],
    clientFactory: createSdkClientFactory(),
    resilience: { failureThreshold: 3, cooldownMs: 3_000, heartbeat: { enabled: false } },
    defaultTimeoutMs: 5_000,
  });
  const t0 = Date.now();
  const results = await hub.indexAll();
  const elapsed = Date.now() - t0;
  const dead = results.find((r) => r.serverId === "dead")!;
  const live = results.find((r) => r.serverId === "f16")!;
  assert.equal(live.indexed, 1, "healthy server indexed");
  assert.match(dead.error ?? "", /timed out|aborted|closed/i);
  assert.ok(elapsed < 5_000, `indexAll took ${elapsed}ms — must complete near the deadline`);
  const [deadState] = hub.serverStates().filter((s) => s.id === "dead");
  assert.equal(deadState!.status, "unreachable");

  // The spawned child must be gone after the adapter's teardown.
  await new Promise((r) => setTimeout(r, 3_000)); // bounded close window
  const pid = Number(readFileSync(pidFile, "utf8"));
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "the hung child process must be reaped after the deadline");
  hub.close();
  rmSync(scratch, { recursive: true, force: true });
});
