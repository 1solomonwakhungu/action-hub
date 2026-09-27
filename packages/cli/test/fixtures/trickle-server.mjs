// Doctor fixture (reviewer-1 PR 61 round 6): writes ONE arbitrary stdout byte
// and then hangs forever. Defeats any "saw stdout => initialized" heuristic;
// the doctor must bound activation via the anchor meta file instead.
import { appendFileSync } from "node:fs";

if (process.env["TREE_PIDS_FILE"]) appendFileSync(process.env["TREE_PIDS_FILE"], `${process.pid}\n`);
process.stdout.write("x");
process.stdin.resume();
