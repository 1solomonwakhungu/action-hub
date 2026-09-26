// Stub daemon process for daemon-start readiness tests (FX10/F25).
// Spawned by daemonStartCommand as `node <this file> __daemon-run`, with stdio
// redirected to the daemon log file.
//
// Modes (via env):
// - SLOW_MS=<n>: write a progress line to stderr every 250ms (drives log-file
//   growth), and only after n ms become a "ready" daemon: write 0600 state
//   + auth-token files and serve the daemon's status protocol on a TCP port.
//   Used to prove a daemon that takes longer than the old fixed 15s wall but
//   is clearly making progress now starts successfully.
// - DIE_MS=<n>: emit progress for n ms, then exit with code 3 — the CLI must
//   fail fast instead of waiting out its whole cap.
// - SILENT=1: stay alive, never write anything, never become ready — the
//   no-progress window must end the wait.
import { createServer } from "node:net";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const daemonDir = process.env["ACTION_HUB_DAEMON_DIR"];
if (!daemonDir) throw new Error("ACTION_HUB_DAEMON_DIR is required");
const slowMs = Number(process.env["SLOW_MS"] ?? 0);
const dieMs = Number(process.env["DIE_MS"] ?? 0);

const progress =
  slowMs > 0 || dieMs > 0
    ? setInterval(() => {
        process.stderr.write(`stub daemon still booting at ${Date.now()}\n`);
      }, 250)
    : undefined;

if (dieMs > 0) {
  setTimeout(() => {
    if (progress) clearInterval(progress);
    process.exit(3);
  }, dieMs);
}

if (slowMs > 0) {
  setTimeout(() => {
    const server = createServer(socket => {
      let buffered = "";
      socket.on("data", (chunk) => {
        buffered += chunk.toString("utf8");
        let idx;
        while ((idx = buffered.indexOf("\n")) >= 0) {
          buffered = buffered.slice(idx + 1);
          socket.write(`${JSON.stringify({ ok: true })}\n`);
        }
      });
      socket.on("error", () => socket.destroy());
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const state = {
        version: 1,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        endpoint: { kind: "tcp", host: "127.0.0.1", port },
      };
      writeFileSync(join(daemonDir, "daemon.json"), JSON.stringify(state));
      chmodSync(join(daemonDir, "daemon.json"), 0o600);
      writeFileSync(join(daemonDir, "auth-token"), `${"0".repeat(64)}\n`);
      chmodSync(join(daemonDir, "auth-token"), 0o600);
      if (progress) clearInterval(progress);
      process.stderr.write("stub daemon ready\n");
    });
  }, slowMs);
}

if (process.env["SILENT"] === "1") {
  // Stay alive forever without writing anything and without ever becoming
  // ready — exercised with a short no-progress window.
  process.stderr.write("stub daemon starting (silent)\n");
  setInterval(() => {}, 1000);
}

process.on("SIGTERM", () => process.exit(0));
