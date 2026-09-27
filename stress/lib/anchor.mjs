/**
 * stress/lib/anchor.mjs — the Design C live-anchor group core (LIB2-R3).
 *
 * Joint ruling (reviewer-1 + reviewer-2): every spawned process group gets a
 * dedicated DETACHED ANCHOR process that is the group leader (PGID) for the
 * handle's entire lifetime. The workload is spawned NON-detached inside the
 * anchor's group. The anchor:
 *   - stays alive through workload exit (the group is never leaderless while
 *     the handle lives — even when the workload spawns+unref's grandchildren);
 *   - relays stdio between the parent and the workload (configurable);
 *   - reports the workload's exit {code, signal} to the parent over the
 *     control channel and keeps running;
 *   - ignores SIGTERM (group-TERM escalation must not kill the ownership
 *     proof mid-cleanup) and exits ONLY when the parent tells it to AFTER
 *     cleanup has verified.
 *
 * Ownership invariant: every negative-PGID signal is allowed ONLY while the
 * exact anchor ChildProcess recorded in the issued handle is still provably
 * ours AND alive (kernel check immediately before the signal). The parent
 * already owns that ChildProcess object — no disk metadata. After the FINAL
 * signal (KILL), only verification happens — never another signal.
 *
 * Fail closed: if the anchor dies unexpectedly (crash, external kill, or was
 * never born), the group is NOT signalled — the verdict reports
 * groupEmpty:false + survivors/error. An anchor-less group can always be a
 * recycled PGID (F39): no leak prevention justifies killing an unrelated
 * process group.
 *
 * Object-identity + terminal-state protections stay as defense in depth.
 */
import { spawn, spawnSync } from "node:child_process";

export class FatalError extends Error {}

const ANCHOR_READY_MS = 15_000;
const ANCHOR_SPAWN_CONFIRM_MS = 15_000;
/** The anchor's TERM-ignoring grace before the parent force-kills IT. */
export const ANCHOR_KILL_GRACE_MS = 5_000;

function sleep(ms) {
  return new Promise((resolveP) => setTimeout(resolveP, ms));
}

/**
 * True when `anchor` is still OUR live child process: the exact ChildProcess
 * recorded in the handle, not yet exited, and kernel-provably alive. This is
 * the ownership gate for every negative-PGID signal.
 */
export function anchorLive(anchor) {
  if (!anchor || typeof anchor.pid !== "number") return false;
  if (anchor.exitCode !== null || anchor.signalCode !== null) return false;
  try {
    process.kill(anchor.pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // exists, probe restricted: still alive
  }
}

/** Best-effort enumeration of pids in a group (POSIX `ps -eo pid,pgid`). */
export function enumerateGroupPids(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0) return [];
  if (process.platform === "win32") return [];
  try {
    const out = spawnSync("ps", ["-eo", "pid,pgid"], { encoding: "utf8", timeout: 3_000 });
    if (out.status !== 0 || typeof out.stdout !== "string") return [];
    const members = [];
    for (const line of out.stdout.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length === 2 && Number(parts[1]) === pgid) members.push(Number(parts[0]));
    }
    return members;
  } catch {
    return [];
  }
}

/**
 * The anchor program (runs via `node -e`). Protocol over fd 3 (POSIX
 * socketpair => duplex; one JSON per line):
 *   parent -> anchor : {"op":"spawn",cmd,args,stdio,env,cwd} | {"op":"exit"}
 *   anchor -> parent : {"op":"ready"} | {"op":"spawn-error",error}
 *                    | {"op":"spawned",pid} | {"op":"workload-exit",code,signal}
 *                    | {"op":"workload-error",error}
 * The anchor ignores SIGTERM. Workload stdio "pipe" entries are relayed:
 * workload stdout/stderr -> anchor fd1/fd2 (parent's readable streams);
 * anchor fd0 (parent's writable stdin stream) -> workload stdin.
 */
/**
 * The anchor program lives in its own file (anchor.program.cjs) — embedding
 * it as a template literal caused a class of escaping bugs (raw newlines
 * inside string literals), and a program file is directly --check-able.
 */
const ANCHOR_PROGRAM_PATH = new URL("./anchor.program.cjs", import.meta.url).pathname;

/**
 * Spawn one anchored group. Resolves once the workload is confirmed spawned
 * (or failed). stdio configures the WORKLOAD's stdio as seen from the
 * parent: "pipe" entries are transparently relayed through the anchor
 * (handle.stdin/stdout/stderr are the relay ends). Default unchanged:
 * ["ignore","pipe","pipe"].
 *
 * @param {object} [anchorOverride] test seam: receives the issued handle
 *   shell and must itself perform the full protocol (used by checks to
 *   exercise the fail-closed path with a dying anchor). Return value:
 *   { anchor: ChildProcess|null, protocol: Promise<exitLike> }.
 */
export function spawnAnchoredGroup(cmd, args, { env, cwd, stdio = ["ignore", "pipe", "pipe"] } = {}, anchorOverride = undefined) {
  return new Promise((resolveHandle) => {
    const issued = { owned: true, terminal: false, pgid: null, pid: null, anchor: null, error: undefined };

    // ---- control plumbing (message QUEUE: nothing is ever dropped) ----
    const queue = [];
    const waiters = [];
    const feed = (msg) => {
      const w = waiters.shift();
      if (w) w(msg);
      else queue.push(msg);
    };
    const nextControl = (timeoutMs) =>
      new Promise((resolveP) => {
        if (queue.length) { resolveP(queue.shift()); return; }
        const w = (msg) => { clearTimeout(timer); resolveP(msg); };
        const timer = setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i !== -1) waiters.splice(i, 1);
          resolveP(null);
        }, timeoutMs);
        waiters.push(w);
      });

    let anchor;
    if (anchorOverride) {
      const o = anchorOverride(issued);
      anchor = o?.anchor ?? null;
      issued.anchor = anchor;
      issued.pgid = anchor ? anchor.pid : null;
      issued.controlDone = o?.protocol ?? Promise.resolve({ error: "override with no protocol" });
    } else {
      try {
        anchor = spawn(process.execPath, [ANCHOR_PROGRAM_PATH], {
          env,
          cwd,
          // fd0/1/2 = workload stdin/stdout/stderr relays; fd3 = control.
          stdio: [
            stdio[0] === "pipe" ? "pipe" : "ignore",
            stdio[1] === "pipe" ? "pipe" : "ignore",
            stdio[2] === "pipe" ? "pipe" : "ignore",
            "pipe",
          ],
          detached: true, // fresh process group; anchor is the PGID leader
        });
      } catch (err) {
        issued.terminal = true;
        issued.error = "anchor spawn failed: " + err.message;
        issued.exited = Promise.resolve({ code: null, signal: null, error: issued.error });
        issued.controlDone = Promise.resolve({});
        resolveHandle(issued);
        return;
      }
      issued.anchor = anchor;
      issued.pgid = anchor.pid ?? null;
      // Relay surfaces: the parent talks to the workload through the anchor.
      issued.stdin = anchor.stdin ?? null;
      issued.stdout = anchor.stdout ?? null;
      issued.stderr = anchor.stderr ?? null;
      const ctrl = anchor.stdio?.[3];
      let lineBuf = "";
      ctrl?.setEncoding?.("utf8");
      ctrl?.on?.("data", (d) => {
        lineBuf += String(d);
        let idx;
        while ((idx = lineBuf.indexOf("\n")) !== -1) {
          const line = lineBuf.slice(0, idx);
          lineBuf = lineBuf.slice(idx + 1);
          try { feed(JSON.parse(line)); } catch { feed(null); }
        }
      });
      ctrl?.on?.("error", () => {});
      // If the anchor dies without reporting, surface that.
      anchor.on("close", (code, signal) => feed({ op: "anchor-exit", code, signal }));
    }

    // ---- the anchor lifecycle protocol ----
    issued.exited = (async () => {
      if (!anchor) return { code: null, signal: null, error: issued.error };
      const ready = await nextControl(ANCHOR_READY_MS);
      if (!ready || ready.op !== "ready") {
        issued.terminal = true;
        return { code: null, signal: null, error: ready?.error ?? "anchor did not report ready" };
      }
      try {
        ctrlWrite(issued, { op: "spawn", cmd, args, stdio, env, cwd });
      } catch (err) {
        issued.terminal = true;
        return { code: null, signal: null, error: "anchor control write failed: " + err.message };
      }
      const spawned = await nextControl(ANCHOR_SPAWN_CONFIRM_MS);
      if (!spawned || spawned.op !== "spawned") {
        issued.terminal = true;
        return { code: null, signal: null, error: spawned?.error ?? "workload spawn not confirmed" };
      }
      issued.pid = spawned.pid ?? null;
      resolveHandle(issued); // handle only becomes visible AFTER spawn confirm
      for (;;) {
        const msg = await nextControl(2_147_000_000);
        if (!msg) continue;
        if (msg.op === "workload-exit") return { code: msg.code, signal: msg.signal };
        if (msg.op === "workload-error") return { code: null, signal: null, error: msg.error };
        if (msg.op === "anchor-exit") {
          // The ANCHOR's death, NOT the workload's — callers must never adopt
          // this as the workload's code/signal (it would misreport the
          // ownership proof's own SIGKILL as the workload result).
          return { code: null, signal: null, anchorDied: true, anchorCode: msg.code, anchorSignal: msg.signal, error: "anchor exited before reporting workload exit" };
        }
      }
    })();

    issued.controlDone = issued.exited.then(() => {}, () => {});
    if (!anchorOverride) {
      // Handles for spawn failures resolve inside exited; make sure the
      // caller always gets a handle object even then.
      issued.exited.then((e) => {
        if (e.error && issued.pid === null) { issued.error = e.error; resolveHandle(issued); }
      }, () => {});
    }
  });
}

function ctrlWrite(handle, obj) {
  const ctrl = handle.anchor?.stdio?.[3];
  if (!ctrl) throw new FatalError("no control channel");
  ctrl.write(JSON.stringify(obj) + "\n");
}

/**
 * Tell the anchor cleanup is complete; it exits 0. If it ignores (protocol
 * wedged), SIGKILL the anchor PID itself — the anchor ChildProcess object is
 * provably ours, so a direct single-pid kill is always safe. Never signals
 * the group negatively here.
 */
export async function shutdownAnchor(handle, { deadlineMs = ANCHOR_KILL_GRACE_MS } = {}) {
  const anchor = handle?.anchor;
  if (!anchor || !anchorLive(anchor)) return { ok: false, error: "anchor not live at shutdown" };
  try {
    ctrlWrite(handle, { op: "exit" });
  } catch {
    /* fall through to the direct kill below */
  }
  const deadline = Date.now() + deadlineMs;
  while (anchorLive(anchor) && Date.now() < deadline) await sleep(50);
  if (anchorLive(anchor)) {
    signalPid(anchor.pid, "SIGKILL");
    await anchorClosing(anchor);
    return { ok: true, forced: true };
  }
  await anchorClosing(anchor);
  return { ok: true };
}

function signalPid(pid, sig) {
  try { process.kill(pid, sig); } catch { /* gone */ }
}

async function anchorClosing(anchor) {
  if (!anchor || anchor.exitCode !== null || anchor.signalCode !== null) return;
  await new Promise((resolveP) => {
    const t = setTimeout(resolveP, ANCHOR_KILL_GRACE_MS);
    anchor.once("close", () => { clearTimeout(t); resolveP(); });
  });
}
