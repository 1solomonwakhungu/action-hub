import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";

/**
 * Anchored process-group supervision (F39/F39b).
 *
 * Problem: POSIX process groups are identified by the leader's PID. Once the
 * leader exits and is reaped, that PGID can be REUSED by an unrelated group,
 * so any signal sent to `-PGID` after the leader died can hit innocent
 * processes (observed: verification runners were SIGTERMed). Signalling is
 * only provably safe while a member of OUR group — ideally the leader we
 * spawned ourselves — is still alive.
 *
 * Design:
 *  - The CLI/doctor spawns the ANCHOR (detached where we control the spawn).
 *  - The anchor spawns the WRAPPER detached, so the WRAPPER is ALWAYS a fresh
 *    process-group leader whose PGID cannot be reused while it lives.
 *  - The wrapper spawns the real server NON-detached inside its group,
 *    relays stdio, ignores SIGTERM, and never exits on its own: it stays
 *    alive as the living proof that the PGID is ours until the final
 *    group SIGKILL (which includes the wrapper itself).
 *  - EVERY group signal is gated: `kill(wrapperPid, 0)` must succeed
 *    immediately before `kill(-wrapperPid, sig)`. No group signal is ever
 *    sent after the wrapper died. No polling loops re-signal groups.
 *  - The wrapper reports the server's exit to the anchor over fd 3
 *    ("EXIT:<code>"); the anchor then runs the kill sequence and exits with
 *    the server's code.
 *  - The HOST holds the anchor's PID directly (its own ChildProcess, or the
 *    transport child captured at spawn). There is NO disk PID metadata: the
 *    untrusted server can never see or forge control state. Host teardown
 *    only ever signals the anchor (single-PID, always safe) and lets the
 *    anchor do the gated group work it can prove from inside. If the anchor
 *    is unexpectedly dead, the host FAILS CLOSED and reports — it never
 *    signals a group it cannot prove is its own.
 */

const KILLER_REQUIRED = false; // no detached killer needed: gated signals only

const WRAPPER_SRC = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const command = process.argv[1];
const serverArgs = process.argv.slice(2);
if (!command) process.exit(2);
// The wrapper is the group leader and must stay alive (anchoring the PGID)
// until the anchor SIGKILLs the whole group. SIGTERM is ignored on purpose.
process.on("SIGTERM", () => {});
// SECURITY (PR 77 rework): the server is untrusted and must never see host
// control metadata. Strip every ANCHOR_* variable from its environment.
const serverEnv = { ...process.env };
for (const key of Object.keys(serverEnv)) {
  if (key.startsWith("ANCHOR_")) delete serverEnv[key];
}
const server = spawn(command, serverArgs, {
  stdio: ["pipe", "pipe", "pipe"],
  env: serverEnv,
  cwd: process.cwd(),
});
const report = (line) => { try { fs.writeSync(3, line + "\\n"); } catch {} };
const swallow = (fn) => () => { try { fn(); } catch {} };
process.stdin.on("data", (chunk) => { try { server.stdin.write(chunk); } catch {} });
process.stdin.on("end", swallow(() => server.stdin.end()));
process.stdin.on("error", () => {});
server.stdin.on("error", () => {});
server.stdout.on("data", (chunk) => { try { fs.writeSync(1, chunk); } catch {} });
server.stderr.on("data", (chunk) => { try { fs.writeSync(2, chunk); } catch {} });
server.stdout.on("error", () => {});
server.stderr.on("error", () => {});
server.on("error", () => report("EXIT:1"));
server.on("exit", (code) => report("EXIT:" + (code === null ? "signal" : code)));
// Never exit on our own: only the anchor's group SIGKILL ends us.
setInterval(() => {}, 60000);
`;

export const ANCHOR_SRC = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const isWin = process.platform === "win32";
const mode = process.argv[1];
const command = process.argv[2];
const serverArgs = process.argv.slice(3);
if (!command) process.exit(2);
const stdoutDeadlineMs = Number(process.env["ANCHOR_STDOUT_DEADLINE_MS"] || 0);
const relayStdin = mode === "doctor";
let sawStdout = false;
let killStarted = false;
let serverExitCode = null;
let serverSignalled = false;
// The anchor may receive SIGTERM from its host (bounded teardown): run the
// cleanup sequence, then exit. It is NOT a member of the wrapper's group.
process.on("SIGTERM", () => { startKillSequence("host-sigterm"); });
process.on("SIGINT", () => { startKillSequence("host-sigint"); });
const wrapperAlive = () => {
  try { process.kill(wrapper.pid, 0); return true; } catch { return false; }
};
// Gated group signal: provably safe because the wrapper (the group's leader)
// is verified alive immediately beforehand, so the PGID cannot have been
// reused. Never called after the wrapper died.
const signalGroup = (signal) => {
  if (isWin) { try { wrapper.kill("SIGKILL"); } catch {} return; }
  if (!wrapperAlive()) return false;
  try { process.kill(-wrapper.pid, signal); } catch {}
  return true;
};
const startKillSequence = (why) => {
  if (killStarted) return;
  killStarted = true;
  if (isWin) {
    // child.kill is NOT a tree kill on Windows and the wrapper is not a
    // group leader there: taskkill /T /F the wrapper tree, await it, then
    // exit. The anchor stays a live tree root until this completes.
    const tk = spawn("taskkill", ["/pid", String(wrapper.pid), "/T", "/F"], { stdio: "ignore" });
    const done = () => finalize();
    tk.on("exit", done);
    tk.on("error", () => { try { wrapper.kill("SIGKILL"); } catch {} done(); });
    return;
  }
  signalGroup("SIGTERM");
  const escalate = setTimeout(() => {
    signalGroup("SIGKILL");
    finalize();
  }, 150);
  // Ref'd on purpose: the anchor must stay alive to escalate and exit.
  escalate.unref?.();
  // Absolute fallback in case timers are somehow gone.
  const deadline = setTimeout(() => finalize(), 5000);
  deadline.unref?.();
};
const finalize = () => {
  try { if (mode === "daemon") process.exit(serverExitCode ?? 0); } catch {}
  process.exit(0);
};
const wrapper = spawn(process.execPath, ["-e", ${JSON.stringify(WRAPPER_SRC)}, command, ...serverArgs], {
  detached: !isWin,
  stdio: relayStdin ? ["pipe", "pipe", "pipe", "pipe"] : ["ignore", "inherit", "inherit", "pipe"],
  env: process.env,
  cwd: process.cwd(),
});
wrapper.on("error", () => { startKillSequence("wrapper-error"); });
wrapper.once("exit", () => {
  // The wrapper must never exit on its own; if it was killed externally with
  // descendants still inside, do a single gated attempt (best effort) and
  // exit. There is no reuse-safe way to signal a dead leader's group, so
  // this is intentionally a single shot with a liveness check.
  if (!killStarted) startKillSequence("wrapper-external-exit");
  else finalize();
});
if (relayStdin) {
  process.stdin.on("data", (chunk) => { try { wrapper.stdin.write(chunk); } catch {} });
  process.stdin.on("end", () => { startKillSequence("stdin-end"); });
  process.stdin.on("error", () => { startKillSequence("stdin-error"); });
  wrapper.stdin.on("error", () => {});
  wrapper.stdout.on("data", (chunk) => { sawStdout = true; process.stdout.write(chunk); });
  wrapper.stderr.on("data", (chunk) => process.stderr.write(chunk));
  wrapper.stdout.on("error", () => {});
  wrapper.stderr.on("error", () => {});
} else {
  wrapper.stdout?.on?.("error", () => {});
  wrapper.stderr?.on?.("error", () => {});
}
if (stdoutDeadlineMs > 0) {
  const t = setTimeout(() => { if (!sawStdout) startKillSequence("stdout-deadline"); }, stdoutDeadlineMs);
  t.unref?.();
}
const reportFd = wrapper.stdio[3];
if (reportFd && typeof reportFd.on === "function") {
  let buffered = "";
  reportFd.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    let idx;
    while ((idx = buffered.indexOf("\\n")) >= 0) {
      const line = buffered.slice(0, idx).trim();
      buffered = buffered.slice(idx + 1);
      if (line.startsWith("EXIT:")) {
        const raw = line.slice(5);
        const parsed = Number.parseInt(raw, 10);
        serverExitCode = Number.isSafeInteger(parsed) ? parsed : null;
        serverSignalled = raw === "signal";
        startKillSequence("server-exit");
      }
    }
  });
  reportFd.on("error", () => {});
}
// Keep the anchor alive while the wrapper lives; finalize() exits explicitly.
setInterval(() => {}, 60000);
`.replace("${JSON.stringify(WRAPPER_SRC)}", "'\" + JSON.stringify(WRAPPER_SRC) + \"'");

export interface TeardownResult {
  /** PIDs that are still alive after teardown. Empty = all dead. */
  survivors: number[];
  /**
   * True when teardown of the anchored tree was proven (the anchor was
   * alive, ran its own gated cleanup, and exited). False = fail closed: the
   * host must treat the tree as unverified and report a failure rather than
   * signal anything it cannot prove is its own.
   */
  proven: boolean;
}

const isWindows = platform() === "win32";

export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Gated teardown of ONE anchored tree whose anchor PID the host holds
 * directly. The host only ever signals the ANCHOR (single-PID signal, safe
 * unconditionally): a living anchor performs its own group cleanup from
 * inside, where the wrapper PID is known and every group signal is gated on
 * the wrapper being alive. If the anchor cannot be proven dead-and-cleaned,
 * the result is fail-closed — the host NEVER guesses at group PIDs.
 */
export async function teardownAnchorChild(
  anchorPid: number,
  timeoutMs = 5_000,
): Promise<TeardownResult> {
  if (!pidAlive(anchorPid)) return { survivors: [], proven: false };
  try {
    process.kill(anchorPid, "SIGTERM");
  } catch {}
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(anchorPid) && Date.now() < deadline) await delay(50);
  if (!pidAlive(anchorPid)) return { survivors: [], proven: true };
  if (isWindows) {
    // The anchor is a live tree root: taskkill /T /F covers wrapper + server.
    try {
      await new Promise<void>((resolve) => {
        const tk = spawn("taskkill", ["/pid", String(anchorPid), "/T", "/F"], { stdio: "ignore" });
        tk.on("exit", () => resolve());
        tk.on("error", () => resolve());
      });
    } catch {}
    await delay(500);
    return { survivors: pidAlive(anchorPid) ? [anchorPid] : [], proven: !pidAlive(anchorPid) };
  }
  // POSIX: the anchor ignored our TERM long enough to be wedged. SIGKILLing
  // it cannot be proven to clean the group, so fail closed and report.
  try {
    process.kill(anchorPid, "SIGKILL");
  } catch {}
  await delay(100);
  return { survivors: pidAlive(anchorPid) ? [anchorPid] : [], proven: false };
}

/** Bounded spawn of the anchor used by hosts. Returns the child. */
export function spawnAnchor(
  mode: "daemon" | "doctor",
  command: string,
  args: string[],
  options: { detached: boolean; stdio: ("ignore" | "inherit" | "pipe" | number)[]; env: NodeJS.ProcessEnv; stdoutDeadlineMs?: number },
): ChildProcess {
  const env = { ...options.env };
  if (options.stdoutDeadlineMs) env["ANCHOR_STDOUT_DEADLINE_MS"] = String(options.stdoutDeadlineMs);
  return spawn(process.execPath, ["-e", ANCHOR_SRC, mode, command, ...args], {
    detached: options.detached,
    stdio: options.stdio,
    env,
  });
}

// Silence unused warnings for optional knobs kept for clarity.
void KILLER_REQUIRED;
