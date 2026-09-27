// PR 77 rework round 4: reports its own PID and its parent's (the wrapper's)
// PID over stderr, records its PID for the test, then hangs. The test kills
// ONLY the wrapper; the anchor must report FAILURE (exit 3), the host must
// fail closed, and this server must never be killed by a guessed group
// signal (the test verifies it is still alive, then kills it itself).
import { appendFileSync } from "node:fs";

if (process.env["TREE_PIDS_FILE"]) appendFileSync(process.env["TREE_PIDS_FILE"], `${process.pid}\n`);
process.stderr.write(`PPID:${process.ppid}\n`);
process.stdin.resume();
// Durable handle: the server must survive stdin EOF, so any later death is
// attributable to a signal, not to the pipe closing.
setInterval(() => {}, 1000);
