// F27 regression fixture: a server that never answers initialize. Writes its
// pid (F16_PID_FILE) so the test can prove the child was reaped after the
// activation deadline killed it.
import { writeFileSync } from "node:fs";
if (process.env.F16_PID_FILE) writeFileSync(process.env.F16_PID_FILE, String(process.pid));
process.stdin.resume(); // never respond
