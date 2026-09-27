import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
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
 * WRAPPER process (runs as `this-cli __wrapper-run <command> <serverArgs...>`,
 * but ONLY launchable by an anchor — see the authentication below). The
 * wrapper is the group leader and must stay alive (anchoring the PGID) until
 * the anchor SIGKILLs the whole group; it relays stdio and reports the
 * server's exit to the anchor over fd 3.
 */
export function runWrapperProcess(argvTail: string[]): void {
  const isWin = process.platform === "win32";
  const command = argvTail[0];
  const serverArgs = argvTail.slice(1);
  if (!command) process.exit(2);
  // --- Anchor-only launch authentication (review round 10) ---
  // The anchor generates a one-time token and passes it both via the wrapper's
  // environment and over a control pipe (fd 4) that only a live anchor holds
  // the write end of. A direct argv invocation has no control pipe and no
  // token, and exits 2 BEFORE any server is spawned: the wrapper is not a
  // user-facing keep-alive primitive. (An attacker able to forge a connected
  // control pipe already controls the spawn itself — outside this model.)
  const expectedToken = process.env["ANCHOR_CONTROL_TOKEN"];
  if (!expectedToken || !/^[0-9a-f]{64}$/.test(expectedToken)) {
    process.stderr.write("__wrapper-run is an internal anchor mode and cannot be invoked directly\n");
    process.exit(2);
  }
  let control: import("node:stream").Readable;
  try {
    control = fs.createReadStream(null as unknown as string, { fd: 4 });
  } catch {
    process.stderr.write("__wrapper-run is an internal anchor mode and cannot be invoked directly\n");
    process.exit(2);
  }
  let authenticated = false;
  let killStarted = false;
  const preAuthStdin: Buffer[] = [];
  const refuse = (why: string): never => {
    process.stderr.write(`__wrapper-run: ${why}\n`);
    process.exit(2);
  };
  // --- Parent-loss self-teardown (review round 10) ---
  // The control pipe's write end lives only inside the anchor process: EOF
  // here means the anchor is gone (crash or SIGKILL — nothing else ever
  // closes it). The wrapper IS the group's live leader, so the PGID is
  // provably ours and cannot have been reused; tear our own group down,
  // bounded, instead of orphaning the server forever.
  const selfTeardown = (why: string) => {
    if (killStarted) return;
    killStarted = true;
    try { fs.writeSync(2, `__wrapper-run: anchor lost (${why}); tearing down group\n`); } catch {}
    if (isWin) {
      // No process groups on Windows. The server is our direct child, so
      // server.kill works even where taskkill cannot; taskkill /T /F on our
      // own pid is the tree sweep that also takes US down. Every attempt is
      // VERIFIED: the wrapper must never exit while the server is still
      // alive — a failed taskkill must not silently orphan the tree.
      const serverDead = (): boolean => {
        if (!server) return true;
        if (server.exitCode !== null || server.signalCode !== null) return true;
        try { process.kill(server.pid!, 0); return false; } catch { return true; }
      };
      let attempts = 0;
      const attemptTeardown = () => {
        attempts++;
        try { server?.kill("SIGKILL"); } catch {}
        const tk = spawn("taskkill", ["/pid", String(process.pid), "/T", "/F"], { stdio: "ignore" });
        // A taskkill that works kills this wrapper too; the verification
        // below only runs when it did NOT (launch failure or nonzero exit).
        tk.on("error", () => {});
        setTimeout(() => {
          if (serverDead()) {
            process.exit(4);
            return;
          }
          if (attempts < 6) { attemptTeardown(); return; }
          // Every bounded attempt failed: report it LOUDLY, then never
          // exit while the server lives — keep attempting (and holding the
          // group open) instead of silently orphaning it.
          try { fs.writeSync(2, "__wrapper-run: WARNING teardown attempts exhausted; server still alive; continuing attempts\n"); } catch {}
          const keepTrying = setInterval(attemptTeardown, 2000);

        }, 400);
      };
      attemptTeardown();
      return;
    }
    // We are the group leader, so the PGID is ours by construction and
    // cannot have been reused while we live. SIGTERM is ignored by us (see
    // below), so only the server dies in phase 1; SIGKILL then takes the
    // whole group — including this wrapper — boundedly.
    try { process.kill(-process.pid, "SIGTERM"); } catch {}
    setTimeout(() => {
      try { process.kill(-process.pid, "SIGKILL"); } catch {}
      // Only reachable if SIGKILL somehow did not include us; never linger.
      process.exit(4);
    }, 150);
  };
  const authTimer = setTimeout(() => {
    if (!authenticated) refuse("anchor authentication handshake timed out");
  }, 2000);
  let buffered = "";
  control.on("data", (chunk: Buffer) => {
    if (authenticated) return;
    buffered += chunk.toString("utf8");
    const idx = buffered.indexOf("\n");
    if (idx < 0) return;
    const line = buffered.slice(0, idx).trim();
    const expected = `ANCHOR_AUTH:${expectedToken}`;
    const ok = line.length === expected.length && timingSafeEqual(Buffer.from(line), Buffer.from(expected));
    if (!ok) { clearTimeout(authTimer); refuse("anchor authentication failed"); }
    authenticated = true;
    clearTimeout(authTimer);
    startServer();
  });
  control.on("end", () => {
    if (!authenticated) { clearTimeout(authTimer); refuse("control channel closed before authentication"); }
    else selfTeardown("anchor-lost");
  });
  control.on("error", () => {
    if (!authenticated) { clearTimeout(authTimer); refuse("control channel unavailable"); }
  });
  let server: import("node:child_process").ChildProcess | null = null;
  const report = (line: string) => { try { fs.writeSync(3, line + "\n"); } catch {} };
  process.stdin.on("data", (chunk) => {
    if (server) { try { server.stdin!.write(chunk); } catch {} }
    else preAuthStdin.push(chunk);
  });
  process.stdin.on("end", () => { try { server?.stdin!.end(); } catch {} });
  process.stdin.on("error", () => {});
  const startServer = () => {
    // The wrapper is the group leader and must stay alive (anchoring the
    // PGID) until the anchor SIGKILLs the whole group or this wrapper's own
    // parent-loss self-teardown ends it. SIGTERM is ignored on purpose.
    process.on("SIGTERM", () => {});
    // SECURITY (PR 77 rework): the server is untrusted and must never see host
    // control metadata. Strip every ANCHOR_* variable (incl. the control
    // token) from its environment.
    const serverEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(serverEnv)) {
      if (key.startsWith("ANCHOR_")) delete serverEnv[key];
    }
    server = spawn(command, serverArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: serverEnv,
      cwd: process.cwd(),
    });
    for (const chunk of preAuthStdin) { try { server.stdin!.write(chunk); } catch {} }
    preAuthStdin.length = 0;
    server.stdin!.on("error", () => {});
    server.stdout!.on("data", (chunk) => { try { fs.writeSync(1, chunk); } catch {} });
    server.stderr!.on("data", (chunk) => { try { fs.writeSync(2, chunk); } catch {} });
    server.stdout!.on("error", () => {});
    server.stderr!.on("error", () => {});
    server.on("error", () => report("EXIT:1"));
    server.on("exit", (code) => report("EXIT:" + (code === null ? "signal" : code)));
    // Never exit on our own: only the anchor's group SIGKILL or the wrapper's
    // own parent-loss self-teardown ends us.
    setInterval(() => {}, 60000);
  };
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
  // One-time token proving the wrapper was launched by THIS anchor, delivered
  // both via env and over the control pipe (fd 4): a wrapper without a live
  // anchor refuses to start a server at all (review round 10).
  const controlToken = randomBytes(32).toString("hex");
  const wrapper = spawn(process.execPath, hostArgs(WRAPPER_MODE, [command, ...serverArgs]), {
    detached: !isWin,
    stdio: relayStdin ? ["pipe", "pipe", "pipe", "pipe", "pipe"] : ["ignore", "inherit", "inherit", "pipe", "pipe"],
    env: { ...process.env, ANCHOR_CONTROL_TOKEN: controlToken },
    cwd: process.cwd(),
  });
  // Hold the control pipe's write end for the anchor's whole life: its OS-level
  // close (crash OR SIGKILL) is the wrapper's parent-loss signal. Never ended
  // deliberately; only process exit closes it.
  const anchorControlEnd = wrapper.stdio![4] as import("node:stream").Writable | null;
  try { anchorControlEnd?.write(`ANCHOR_AUTH:${controlToken}\n`); } catch {}
  anchorControlEnd?.on?.("error", () => {});
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
