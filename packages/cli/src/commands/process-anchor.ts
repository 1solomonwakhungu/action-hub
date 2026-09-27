import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { platform } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * This CLI's own entry path (dist/index.js under node, the binary itself
 * inside a SEA single-file build). Module-derived — argv[1] is unreliable for
 * embedded/library callers (e.g. in-process tests).
 */
function selfEntryPath(): string {
  // ESM dist build (in-repo and tests): this module is dist/commands/process-anchor.js.
  try {
    const here = fileURLToPath(import.meta.url);
    if (here && here.endsWith("process-anchor.js")) {
      return resolve(dirname(here), "..", "index.js");
    }
  } catch {}
  // CJS bundle (SEA): __filename is the bundle script path; inside a SEA
  // build it is the binary path itself. Eval keeps bundlers from renaming it.
  try {
    const fn = (0, eval)("typeof __filename !== 'undefined' ? __filename : undefined") as string | undefined;
    if (typeof fn === "string") {
      if (resolve(fn) === resolve(process.execPath)) return process.execPath;
      return resolve(dirname(fn), "..", "index.js");
    }
  } catch {}
  // Last resort: the running CLI was invoked as the main module.
  return process.argv[1] ?? process.execPath;
}

export const ANCHOR_MODE = "__anchor-run";
export const WRAPPER_MODE = "__wrapper-run";

/** True when this process runs inside a SEA single-file binary. */
function runningAsSea(): boolean {
  try {
    // node:sea exists only from Node 20.12; the declared floor is 20.11, so
    // the resolution must stay best-effort (never a static module import).
    // process.execPath is always absolute and valid, unlike the bundler-shimmed
    // import.meta.url / relative argv[1] inside a SEA binary.
    const sea = createRequire(process.execPath)("node:sea") as { isSea(): boolean } | undefined;
    return Boolean(sea?.isSea());
  } catch {
    return false;
  }
}

/**
 * Args to re-invoke THIS CLI so it dispatches to `mode`. Under plain node the
 * interpreter needs the script path first; a SEA binary reserves argv[1] for
 * itself, so user args begin there directly.
 */
function hostArgs(mode: string, rest: string[]): string[] {
  return runningAsSea() ? [mode, ...rest] : [selfEntryPath(), mode, ...rest];
}

/** How the host re-invokes this CLI to run an internal anchor mode. */
export function anchorSpawnArgs(
  mode: "daemon" | "doctor",
  command: string,
  serverArgs: string[],
): string[] {
  return hostArgs(ANCHOR_MODE, [mode, command, ...serverArgs]);
}

/**
 * WRAPPER process (runs as `this-cli __wrapper-run <command> <serverArgs...>`).
 * Ported verbatim from the previous `-e` wrapper script: the wrapper is the
 * group leader and must stay alive (anchoring the PGID) until the anchor
 * SIGKILLs the whole group; it relays stdio and reports the server's exit to
 * the anchor over fd 3.
 */
export function runWrapperProcess(argvTail: string[]): void {
  const command = argvTail[0];
  const serverArgs = argvTail.slice(1);
  if (!command) process.exit(2);
  // The wrapper is the group leader and must stay alive (anchoring the PGID)
  // until the anchor SIGKILLs the whole group. SIGTERM is ignored on purpose.
  process.on("SIGTERM", () => {});
  // SECURITY (PR 77 rework): the server is untrusted and must never see host
  // control metadata. Strip every ANCHOR_* variable from its environment.
  const serverEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(serverEnv)) {
    if (key.startsWith("ANCHOR_")) delete serverEnv[key];
  }
  const server = spawn(command, serverArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    env: serverEnv,
    cwd: process.cwd(),
  });
  const report = (line: string) => { try { fs.writeSync(3, line + "\n"); } catch {} };
  const swallow = (fn: () => void) => () => { try { fn(); } catch {} };
  process.stdin.on("data", (chunk) => { try { server.stdin!.write(chunk); } catch {} });
  process.stdin.on("end", swallow(() => server.stdin!.end()));
  process.stdin.on("error", () => {});
  server.stdin!.on("error", () => {});
  server.stdout!.on("data", (chunk) => { try { fs.writeSync(1, chunk); } catch {} });
  server.stderr!.on("data", (chunk) => { try { fs.writeSync(2, chunk); } catch {} });
  server.stdout!.on("error", () => {});
  server.stderr!.on("error", () => {});
  server.on("error", () => report("EXIT:1"));
  server.on("exit", (code) => report("EXIT:" + (code === null ? "signal" : code)));
  // Never exit on our own: only the anchor's group SIGKILL ends us.
  setInterval(() => {}, 60000);
}

/**
 * ANCHOR process (runs as `this-cli __anchor-run <mode> <command> <serverArgs...>`).
 * Ported verbatim from the previous `-e` anchor script, including the
 * teardown PROOF protocol: the anchor exits 0 (EXIT_PROVEN) only after
 * VERIFIED cleanup, anything else (EXIT_FAILED) fails the host closed.
 */
export function runAnchorProcess(argvTail: string[]): void {
  const isWin = process.platform === "win32";
  const mode = argvTail[0] as "daemon" | "doctor";
  const command = argvTail[1];
  const serverArgs = argvTail.slice(2);
  if (!command) process.exit(2);
  const stdoutDeadlineMs = Number(process.env["ANCHOR_STDOUT_DEADLINE_MS"] || 0);
  const relayStdin = mode === "doctor";
  let sawStdout = false;
  let killStarted = false;
  let escalated = false;
  let wrapperDiedUnexpectedly = false;
  // The anchor may receive SIGTERM from its host (bounded teardown): run the
  // cleanup sequence, then exit. It is NOT a member of the wrapper's group.
  process.on("SIGTERM", () => { startKillSequence("host-sigterm"); });
  process.on("SIGINT", () => { startKillSequence("host-sigint"); });
  const wrapperAlive = () => {
    try { process.kill(wrapper.pid!, 0); return true; } catch { return false; }
  };
  // Gated group signal: provably safe because the wrapper (the group's leader)
  // is verified alive immediately beforehand, so the PGID cannot have been
  // reused. Never called after the wrapper died.
  const signalGroup = (signal: NodeJS.Signals) => {
    if (isWin) { try { wrapper.kill("SIGKILL"); } catch {} return; }
    if (!wrapperAlive()) return;
    try { process.kill(-(wrapper.pid as number), signal); } catch {}
  };
  const startKillSequence = (why: string) => {
    if (killStarted) return;
    killStarted = true;
    // An unexpected wrapper death means the group state is unverifiable —
    // there is no reuse-safe way to signal a dead leader's group. Never
    // convert it into proof.
    if (wrapperDiedUnexpectedly) {
      finalize(false);
      return;
    }
    if (isWin) {
      // child.kill is NOT a tree kill on Windows and the wrapper is not a
      // group leader there: taskkill /T /F the wrapper tree, await it, verify
      // the wrapper is gone, then exit with the proof code. The taskkill is
      // OUR kill: a wrapper exit from here is expected, not unexpected.
      escalated = true;
      const tk = spawn("taskkill", ["/pid", String(wrapper.pid), "/T", "/F"], { stdio: "ignore" });
      const done = () => {
        if (tk.exitCode === 0 && !wrapperAlive()) finalize(true);
        else finalize(false);
      };
      tk.on("exit", done);
      tk.on("error", () => { try { wrapper.kill("SIGKILL"); } catch {} finalize(false); });
      return;
    }
    signalGroup("SIGTERM");
    const escalate = setTimeout(() => {
      escalated = true;
      signalGroup("SIGKILL");
      // Verify before claiming success: the wrapper must die BY OUR SIGKILL
      // (wrapperDied after escalation) — poll bounded.
      const verifyDeadline = Date.now() + 2000;
      const verify = setInterval(() => {
        if (wrapperDiedUnexpectedly) {
          clearInterval(verify);
          finalize(false);
        } else if (!wrapperAlive()) {
          clearInterval(verify);
          finalize(true);
        } else if (Date.now() > verifyDeadline) {
          clearInterval(verify);
          finalize(false);
        }
      }, 50);
    }, 150);
    // Ref'd on purpose: the anchor must stay alive to escalate, verify and exit.
    escalate.unref?.();
  };
  const finalize = (proven: boolean) => {
    process.exit(proven ? EXIT_PROVEN : EXIT_FAILED);
  };
  // The wrapper is ALSO this CLI re-invoking itself (zero external deps, safe
  // inside the SEA binary), spawned detached so it is ALWAYS a fresh
  // process-group leader whose PGID cannot be reused while it lives.
  const wrapper = spawn(process.execPath, hostArgs(WRAPPER_MODE, [command, ...serverArgs]), {
    detached: !isWin,
    stdio: relayStdin ? ["pipe", "pipe", "pipe", "pipe"] : ["ignore", "inherit", "inherit", "pipe"],
    env: process.env,
    cwd: process.cwd(),
  });
  wrapper.on("error", () => { startKillSequence("wrapper-error"); });
  wrapper.once("exit", () => {
    // The wrapper must never exit on its own. If it dies before OUR group
    // SIGKILL (or taskkill) was sent, the group state is unverifiable —
    // report failure (the host fails closed); never convert it into proof.
    if (!escalated) {
      wrapperDiedUnexpectedly = true;
      startKillSequence("wrapper-external-exit");
    }
  });
  if (relayStdin) {
    process.stdin.on("data", (chunk) => { try { wrapper.stdin!.write(chunk); } catch {} });
    process.stdin.on("end", () => { startKillSequence("stdin-end"); });
    process.stdin.on("error", () => { startKillSequence("stdin-error"); });
    wrapper.stdin!.on("error", () => {});
    wrapper.stdout!.on("data", (chunk) => { sawStdout = true; process.stdout.write(chunk); });
    wrapper.stderr!.on("data", (chunk) => process.stderr.write(chunk));
    wrapper.stdout!.on("error", () => {});
    wrapper.stderr!.on("error", () => {});
  } else {
    wrapper.stdout?.on?.("error", () => {});
    wrapper.stderr?.on?.("error", () => {});
  }
  if (stdoutDeadlineMs > 0) {
    const t = setTimeout(() => { if (!sawStdout) startKillSequence("stdout-deadline"); }, stdoutDeadlineMs);
    t.unref?.();
  }
  const reportFd = wrapper.stdio![3];
  if (reportFd && typeof (reportFd as import("node:stream").Readable).on === "function") {
    let buffered = "";
    (reportFd as import("node:stream").Readable).on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let idx;
      while ((idx = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, idx).trim();
        buffered = buffered.slice(idx + 1);
        if (line.startsWith("EXIT:")) {
          startKillSequence("server-exit");
        }
      }
    });
    (reportFd as import("node:stream").Readable).on("error", () => {});
  }
  // Keep the anchor alive while the wrapper lives; finalize() exits explicitly.
  setInterval(() => {}, 60000);
}

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

/** Anchor exit code meaning "group cleanup verified". */
export const EXIT_PROVEN = 0;
/** Anchor exit code meaning "cleanup could not be verified/failed". */
export const EXIT_FAILED = 3;

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
 * Gated teardown of ONE anchored tree whose anchor ChildProcess the host
 * holds directly. The host only ever signals the ANCHOR it spawned
 * (single-PID signal, safe unconditionally); the anchor performs its own
 * group cleanup from inside, where the wrapper PID is known and every group
 * signal is gated on the wrapper being alive. Proof is the anchor's EXIT
 * CODE (0 = verified cleanup; anything else = failure). If the anchor cannot
 * be proven cleaned, the result is fail-closed — the host NEVER guesses at
 * group PIDs and never reconstructs authority from a number.
 */
export async function teardownAnchorChild(
  child: ChildProcess,
  timeoutMs = 5_000,
): Promise<TeardownResult> {
  if (child.pid === undefined) return { survivors: [], proven: false };
  const alreadyExited = child.exitCode !== null || child.signalCode !== null;
  if (!alreadyExited) {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
  const deadline = Date.now() + timeoutMs;
  while ((child.exitCode === null && child.signalCode === null) && Date.now() < deadline) {
    await delay(50);
  }
  if (child.exitCode === EXIT_PROVEN) return { survivors: [], proven: true };
  if (child.exitCode !== null || child.signalCode !== null) {
    // Exited with a failure proof (or was killed): fail closed.
    return { survivors: [], proven: false };
  }
  // Still alive past the deadline: SIGKILL the anchor (Windows: taskkill the
  // tree) and fail closed — the group state is unverifiable.
  try {
    if (isWindows) {
      await new Promise<void>((resolve) => {
        const tk = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        tk.on("exit", () => resolve());
        tk.on("error", () => resolve());
      });
    } else {
      process.kill(child.pid, "SIGKILL");
    }
  } catch {}
  await delay(100);
  return { survivors: pidAlive(child.pid) ? [child.pid] : [], proven: false };
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
  // The anchor is THIS CLI re-invoking itself with a hidden internal mode —
  // no external interpreter is required, so the standalone SEA binary keeps
  // its zero-dependency contract (docs/releasing.md).
  return spawn(process.execPath, hostArgs(ANCHOR_MODE, [mode, command, ...args]), {
    detached: options.detached,
    stdio: options.stdio,
    env,
  });
}
