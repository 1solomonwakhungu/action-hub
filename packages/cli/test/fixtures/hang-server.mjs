// Doctor fixture: a stdio server that never answers initialize — it records
// its own PID to TREE_PIDS_FILE (if set) and then hangs on stdin. Used to
// prove the doctor's activation deadline and supervisor reap hung servers.
import { appendFileSync } from "node:fs";

const pidFile = process.env["TREE_PIDS_FILE"];
if (pidFile) appendFileSync(pidFile, `${process.pid}\n`);
process.stdin.resume();
