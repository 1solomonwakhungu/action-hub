// PR 77 rework round 10 (reviewer-1 P1): orphan regression fixture. Reports
// its own PID and the wrapper's PID (its ppid) to TREE_PIDS_FILE, then hangs.
// The test SIGKILLs ONLY the anchor; the wrapper must detect the anchor's
// death over its control pipe and tear its own group down boundedly, taking
// this server with it — no orphaned wrapper, no orphaned server.
import { appendFileSync } from "node:fs";

if (process.env["TREE_PIDS_FILE"]) {
  appendFileSync(process.env["TREE_PIDS_FILE"], `SERVER:${process.pid}\nPPID:${process.ppid}\n`);
}
process.stdin.resume();
// Durable handle: the server must survive stdin EOF, so its death is
// attributable to the wrapper's group teardown, not to a pipe closing.
setInterval(() => {}, 1000);
