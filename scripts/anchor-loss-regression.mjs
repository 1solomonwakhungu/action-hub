// Cross-OS anchor-loss regression: run against ANY anchor entrypoint
// (dist host under node, or a SEA binary). Kills the anchor (SIGKILL on
// POSIX, taskkill /F on Windows) after the wrapper reports the server
// tree, then asserts the wrapper AND server die within 7s.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Entry: explicit argv[2], else the single built binary in dist-bin, else
// the dist host (dist/index.js).
import { readdirSync, existsSync } from "node:fs";
let entryArg = process.argv[2];
if (!entryArg) {
  const binDir = resolve("dist-bin");
  if (existsSync(binDir)) {
    const files = readdirSync(binDir);
    if (files.length === 1) entryArg = join(binDir, files[0]);
  }
}
const entry = entryArg ? resolve(entryArg) : resolve("packages/cli/dist/index.js");
// A .js/.mjs entry is not executable: run it through node. Spawn errors are
// handled explicitly (no unhandled ChildProcess error crash).
const isJsEntry = entry.endsWith(".js") || entry.endsWith(".mjs");
const isWin = process.platform === "win32";
const fixture = resolve("packages/cli/test/fixtures/orphan-probe-server.mjs");
const dir = mkdtempSync(join(tmpdir(), "anchor-loss-"));
const pidsFile = join(dir, "tree.json");

const anchor = spawn(isJsEntry ? process.execPath : entry, isJsEntry ? [entry, "__anchor-run", "daemon", process.execPath, fixture] : ["__anchor-run", "daemon", process.execPath, fixture], {
  stdio: ["ignore", "ignore", "ignore"],
  env: { ...process.env, TREE_PIDS_FILE: pidsFile },
});
anchor.on("error", (cause) => {
  console.error(`FAIL: could not spawn anchor entry ${entry}: ${cause.message}`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});
const anchorPid = anchor.pid;
const deadline = Date.now() + 20000;
let tree = null;
while (Date.now() < deadline) {
  try {
    const raw = await import("node:fs").then((m) => m.readFileSync(pidsFile, "utf8"));
    const mServer = raw.match(/SERVER:(\d+)/);
    const mPpid = raw.match(/PPID:(\d+)/);
    if (mServer && mPpid) { tree = { server: Number(mServer[1]), ppid: Number(mPpid[1]) }; break; }
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
}
if (!tree || !Number.isFinite(tree.server) || !Number.isFinite(tree.ppid)) {
  console.error("FAIL: wrapper never reported the server tree");
  anchor.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); process.exit(1);
}
const { server, ppid: wrapperPid } = tree;
if (isWin) spawnSync("taskkill", ["/F", "/PID", String(anchorPid)], { stdio: "ignore" });
else { try { process.kill(anchorPid, "SIGKILL"); } catch {} }

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const limit = Date.now() + 7000;
let dead = false;
while (Date.now() < limit) {
  if (!alive(wrapperPid) && !alive(server)) { dead = true; break; }
  await new Promise((r) => setTimeout(r, 200));
}
if (!dead) {
  console.error(`FAIL: after anchor loss, wrapper=${alive(wrapperPid) ? "ALIVE" : "dead"} server=${alive(server) ? "ALIVE" : "dead"}`);
  try { spawnSync("taskkill", ["/T", "/F", "/PID", String(wrapperPid)], { stdio: "ignore" }); } catch {}
  try { process.kill(wrapperPid, "SIGKILL"); } catch {}
  try { process.kill(server, "SIGKILL"); } catch {}
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}
console.log(`PASS: anchor ${anchorPid} killed; wrapper ${wrapperPid} and server ${server} both dead`);
rmSync(dir, { recursive: true, force: true });
process.exit(0);
