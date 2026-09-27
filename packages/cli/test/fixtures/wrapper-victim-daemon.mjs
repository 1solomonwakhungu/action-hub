// PR 77 rework round 5: daemon-level repro of the false-green winner path.
// Reports its own PID and the wrapper's PID (its ppid) to TREE_PIDS_FILE, then
// BECOMES READY ONLY AFTER ITS WRAPPER DIES (orphaned: ppid changes). So:
// - before the test SIGKILLs the wrapper, no probe can succeed;
// - after the kill, the orphaned server answers the daemon probe, which the
//   OLD code mistook for a concurrent-start winner (exit 0). The start must
//   instead fail closed on the anchor's failed proof (exit 1).
import { chmodSync, appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

const daemonDir = process.env["ACTION_HUB_DAEMON_DIR"];
if (!daemonDir) throw new Error("ACTION_HUB_DAEMON_DIR is required");

const wrapperPid = process.ppid;
if (process.env["TREE_PIDS_FILE"]) {
  appendFileSync(process.env["TREE_PIDS_FILE"], `SERVER:${process.pid}\nPPID:${wrapperPid}\n`);
}
process.stdin.resume();
setInterval(() => {}, 1000); // survive stdin EOF; death must be signal-attributable

// Become "ready" only once the wrapper is gone.
const orphanPoll = setInterval(() => {
  let ppid = -1;
  try {
    ppid = process.ppid;
  } catch {}
  if (ppid === wrapperPid) return;
  clearInterval(orphanPoll);
  const server = createServer((socket) => {
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
  });
}, 20);
process.on("SIGTERM", () => process.exit(0));
