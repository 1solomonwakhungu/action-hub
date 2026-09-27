import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import { spawnAnchor, teardownAnchorChild, type TeardownResult } from "./process-anchor.js";import { connect, type Socket } from "node:net";
import { homedir, platform, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { runDaemonServer } from "@action-hub/mcp-server";
import { resolvePath } from "../config-loader.js";

const START_TIMEOUT_MS = 15_000;
/**
 * Progress-aware daemon start readiness (FX10/F25):
 * - `DEFAULT_START_TIMEOUT_MS` is the overall cap, configurable via the
 *   `--start-timeout` flag or ACTION_HUB_DAEMON_START_TIMEOUT_MS (default 120s).
 *   At fleet scale (10K tools + 5K skills) cold boot was measured at 120-600s,
 *   so a fixed 15s wall made `daemon start` report "did not become ready" on
 *   healthy, still-booting daemons.
 * - `NO_PROGRESS_TIMEOUT_MS` is how long the start command will wait WITHOUT
 *   any sign of life (log growth, state-file write, or a live pid) before
 *   giving up. Any sign of progress resets this window, so a daemon that is
 *   alive and working gets its full cap, while a hung daemon still fails fast.
 * - If the daemon process exits during startup, we fail immediately.
 * The readiness predicate itself is isolated in `daemonReady()` so the
 * readiness signal can move (e.g. after reindex settles) without touching
 * the wait loop.
 */
const DEFAULT_START_TIMEOUT_MS = 120_000;
const NO_PROGRESS_TIMEOUT_MS = 15_000;
const PROGRESS_LOG_INTERVAL_MS = 2_000;
/** Grace for a concurrently started sibling daemon to become ready after our own child failed. */
const CONCURRENT_START_GRACE_MS = 5_000;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 8 * 1024;

interface DaemonState {
  version: number;
  pid: number;
  startedAt: string;
  /**
   * F63 launch identity: the per-start token daemonStartCommand passes to
   * the daemon via env (ACTION_HUB_LAUNCH_TOKEN) and the daemon echoes into
   * its state. Probe-carried (read synchronously with the ready answer), so
   * identity never depends on relay/event timing.
   */
  launchToken?: string;
  configPath?: string;
  endpoint:
    | { kind: "unix"; path: string }
    | { kind: "tcp"; host: "127.0.0.1"; port: number };
}

interface DaemonPaths {
  dir: string;
  state: string;
  token: string;
  log: string;
}

export interface DaemonOptions {
  configPath?: string;
  daemonDir?: string;
  /** CLI entrypoint override for embedded callers and integration tests. */
  entryPath?: string;
  /** Overall startup cap in ms (default 120000, env/flag overridable). */
  startTimeoutMs?: number;
  /** Called with the detached child's PID as soon as it is spawned. */
  onSpawn?: (pid: number) => void;
}

/** Isolated readiness predicate: a single place to change the readiness signal. */
async function daemonReady(
  paths: DaemonPaths,
): Promise<{ ok: boolean; pid?: number; launchToken?: string } | undefined> {
  const result = await probe(paths).catch(() => undefined);
  if (!result) return undefined;
  return { ok: result.ok, pid: result.state?.pid, launchToken: result.state?.launchToken };
}

function daemonStartCapMs(explicit?: number): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) return explicit;
  const envRaw = process.env["ACTION_HUB_DAEMON_START_TIMEOUT_MS"];
  if (envRaw) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_START_TIMEOUT_MS;
}

/**
 * F63: the anchor's 'exit' event is loop-scheduled and can lag behind a
 * ready-probe success under CPU load. A dead-but-unreported anchor means
 * THIS attempt failed closed — and a ready answer may be OUR OWN orphaned
 * server (the wrapper's group died externally while the server survived),
 * not a concurrent winner. PRIMARY decision (intake ruling, deterministic):
 * the winner path compares the answering pid with OUR relayed SERVER pid —
 * an answer from our own tree is never a winner; it resolves through the
 * anchor's state (healthy = normal start, wrapper-gone = unproven orphan =
 * proof-checked failure). The relay (SERVER/WRAPPER over the anchor's
 * control pipe) is written at spawn time — long before any server could be
 * ready — so it is ordering-stable, unlike the loop-scheduled exit event,
 * which only bounds the residual zombie window (secondary aid below).
 */
const WINNER_EXIT_GRACE_MS = 300;

/** Deterministic F63 identity classification (intake ruling, token-based;
 * exported for the regression suite): how a ready answer relates to OUR
 * spawned attempt. The launch token is PROBE-CARRIED — our daemon echoes
 * ACTION_HUB_LAUNCH_TOKEN into its state at boot and the probe reads it
 * synchronously with the answer — so identity has NO dependency on relay or
 * event delivery timing. Wrapper liveness is a SYNCHRONOUS liveness syscall
 * (via the anchor's WRAPPER:<pid> relay), so the ours/healthy-vs-unproven
 * decision is deterministic even when the anchor's exit event has not been
 * delivered yet.
 */
export type ReadyAnswerClass = "winner" | "ours-healthy" | "ours-unproven" | "undecided";
export function classifyReadyAnswer(
  readyToken: string | undefined,
  ourToken: string,
  wrapperAlive: boolean | "unknown",
  anchorExited: boolean,
): ReadyAnswerClass {
  // An answer without OUR token (foreign daemon, or a token-less legacy
  // state) is a legitimate winner regardless of our anchor's state.
  if (readyToken !== ourToken) return "winner";
  // The answer IS our daemon. Reviewer MUST-FIX (PR 97 r1): when readiness
  // arrives before identity, the winner decision is NOT made on a guess —
  // an unresolved wrapper-liveness relay classifies as "undecided" and the
  // caller keeps waiting until the relay delivers, the anchor reaches a
  // proof-checked terminal state, or the start cap expires (fail closed).
  // A DEFINITIVE terminal state resolves the decision regardless of the
  // relay: with the anchor exited, the answer is an unproven orphan.
  if (anchorExited) return "ours-unproven";
  // Healthy only while our wrapper provably leads the tree (synchronous
  // liveness syscall, not an event); anything else is an unproven orphan of
  // a failed attempt (never a winner, never a silent success).
  if (wrapperAlive === "unknown") return "undecided";
  if (wrapperAlive) return "ours-healthy";
  return "ours-unproven";
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function noProgressWindowMs(): number {
  const envRaw = process.env["ACTION_HUB_DAEMON_NO_PROGRESS_TIMEOUT_MS"];
  if (envRaw) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return NO_PROGRESS_TIMEOUT_MS;
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await lstat(path)).size;
  } catch {
    return -1;
  }
}

/**
 * Best-effort read of the daemon's reindex-settle fields (PR 63: `indexing`,
 * `indexingSettledAt`). Returns undefined when the state file does not exist
 * or does not carry the fields (older daemons), so the wait loop never
 * depends on them being present.
 */
async function readIndexingState(paths: DaemonPaths): Promise<boolean | undefined> {
  try {
    const raw = JSON.parse(await readFile(paths.state, "utf8")) as { indexing?: boolean };
    return typeof raw.indexing === "boolean" ? raw.indexing : undefined;
  } catch {
    return undefined;
  }
}

export function defaultDaemonDir(): string {
  const explicit = process.env["ACTION_HUB_DAEMON_DIR"];
  if (explicit) return resolve(explicit);
  if (platform() === "win32") {
    return resolve(process.env["LOCALAPPDATA"] || join(homedir(), "AppData", "Local"), "action-hub", "daemon");
  }
  const runtime = process.env["XDG_RUNTIME_DIR"];
  if (runtime) return resolve(runtime, "action-hub");
  const uid = typeof process.getuid === "function" ? process.getuid() : userInfo().username;
  return resolve(tmpdir(), `action-hub-${uid}`);
}

export async function daemonStartCommand(options: DaemonOptions = {}): Promise<number> {
  const paths = daemonPaths(options.daemonDir);
  const existing = await probe(paths).catch(() => undefined);
  if (existing?.ok) {
    if (
      options.configPath &&
      existing.state.configPath &&
      existing.state.configPath !== resolvePath(options.configPath)
    ) {
      console.error(
        `Action Hub daemon is already running with config ${existing.state.configPath}. Stop it before switching configs.`,
      );
      return 1;
    }
    console.log(`Action Hub daemon is already running (pid ${existing.state.pid}).`);
    return 0;
  }

  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  if (platform() !== "win32") await chmod(paths.dir, 0o700);

  const logFd = openSync(paths.log, "a", 0o600);
  const launchToken = randomBytes(24).toString("hex");
  const env = {
    ...process.env,
    ACTION_HUB_DAEMON_DIR: paths.dir,
    // F63 launch identity: the daemon echoes this into its state, so every
    // ready answer is self-identifying (probe-carried token, no relay race).
    ACTION_HUB_LAUNCH_TOKEN: launchToken,
    ...(options.configPath ? { ACTION_HUB_CONFIG: resolvePath(options.configPath) } : {}),
  };
  let spawnError: Error | undefined;
  // The daemon runs inside an anchored process group (process-anchor.ts):
  // the anchor's wrapper is the group leader, so every later group signal is
  // provably safe (the leader is verified alive before each signal) and the
  // leader can never be a reused PGID.
  const child = spawnAnchor("daemon", process.execPath, daemonChildArgs(options.entryPath), {
    detached: true,
    stdio: ["ignore", logFd, logFd, "pipe"],
    env,
  });
  // F63 liveness relay: the anchor reports WRAPPER:<pid> at spawn so the
  // host's ours/unproven decision can use a synchronous liveness syscall.
  // IDENTITY itself is token-based (probe-carried — see launchToken), so
  // no winner adoption depends on THIS relay's delivery timing: with the
  // wrapper pid unknown, an ours-token answer simply waits (bounded) for
  // the relay or the attempt's terminal state before classifying.
  let ourWrapperPid: number | undefined;
  if (child.stdio && child.stdio[3] && typeof (child.stdio[3] as import("node:stream").Readable).on === "function") {
    let relayBuffer = "";
    // TEST-ONLY ordering seam (reviewer repro shape): delay only the HOST's
    // relay data-listener processing, so readiness can arrive while the
    // wrapper identity is still undelivered. The anchor stays fully
    // responsive (no blocking); never set in production.
    const relayHoldRaw = Number.parseInt(process.env["ACTION_HUB_TEST_RELAY_HOLD_MS"] ?? "", 10);
    const relayHoldMs = Number.isSafeInteger(relayHoldRaw) && relayHoldRaw > 0 ? relayHoldRaw : 0;
    const processRelayBuffer = () => {
      let idx;
      while ((idx = relayBuffer.indexOf("\n")) >= 0) {
        const line = relayBuffer.slice(0, idx).trim();
        relayBuffer = relayBuffer.slice(idx + 1);
        if (line.startsWith("WRAPPER:")) {
          const parsed = Number.parseInt(line.slice(8), 10);
          if (Number.isSafeInteger(parsed) && parsed > 0) ourWrapperPid = parsed;
        }
      }
    };
    (child.stdio[3] as import("node:stream").Readable).on("data", (chunk: Buffer) => {
      relayBuffer += chunk.toString("utf8");
      if (relayHoldMs > 0) {
        // unref'd: a pending hold must never keep the CLI (or the test
        // runner) alive after daemon start returns.
        const t = setTimeout(processRelayBuffer, relayHoldMs);
        t.unref?.();
      } else {
        processRelayBuffer();
      }
    });
    (child.stdio[3] as import("node:stream").Readable).on("error", () => {});
    // The relay stream MUST NOT hold the host's event loop open: the pipe
    // lives as long as the anchor does, and `daemon start` must exit after
    // reporting success. (Found via the binary smoke: without this, the
    // CLI hung forever after printing "daemon started".) The stdio entry
    // is a net Socket at runtime; only its static type is Readable.
    (child.stdio[3] as unknown as { unref?: () => void }).unref?.();
  }
  child.once("error", (cause) => {
    spawnError = cause;
  });
  if (child.pid) options.onSpawn?.(child.pid);
  child.unref();
  closeSync(logFd);

  // Progress-aware readiness wait (see the constants above).
  const cap = daemonStartCapMs(options.startTimeoutMs);
  const startedAt = Date.now();
  const totalDeadline = startedAt + cap;
  let lastProgressAt = startedAt;
  let lastLogSize = -1;
  let lastProgressPrint = startedAt;
  let childExited = false;
  let childExitCode: number | null = null;
  child.once("exit", (code) => {
    childExited = true;
    childExitCode = code;
  });

  for (;;) {
    if (Date.now() >= totalDeadline) break;
    if (spawnError) {
      await killAndReapSpawned(child);
      // Another concurrent start may have won the race even though ours
      // failed to spawn — report success if a daemon is already ready.
      if (await waitForAnotherDaemon(paths)) {
        return 0;
      }
      console.error(`Could not start Action Hub daemon: ${spawnError.message}`);
      return 1;
    }
    if (childExited) {
      // Teardown FIRST and consult its PROOF: a failed anchor proof (e.g.
      // unexpected wrapper death) must never be papered over by a probe that
      // happens to find the orphaned server of THIS failed start answering.
      const res = await killAndReapSpawned(child);
      if (!res.proven || res.survivors.length > 0) {
        console.error(
          `Action Hub daemon start teardown failed closed (anchor proof invalid). See ${paths.log}`,
        );
        return 1;
      }
      // Concurrent starts are allowed: if OUR child exited but a daemon is
      // already answering (e.g. a sibling start won the lock), succeed. The
      // sibling may still be mid-startup, so poll briefly instead of a single
      // probe.
      if (await waitForAnotherDaemon(paths)) {
        return 0;
      }
      console.error(
        `Action Hub daemon exited during startup (code ${childExitCode ?? "signal"}). See ${paths.log}`,
      );
      return 1;
    }

    const ready = await daemonReady(paths);
    if (childExited) continue; // an exited child must take the proof-checked path below
    if (ready?.ok) {
      // F63 DETERMINISTIC identity check (intake ruling, token-based): the
      // ready answer carries the launch token OUR daemon echoed into its
      // state — probe-carried, so identity has no relay/event timing
      // dependency. An answer WITHOUT our token is a foreign winner. An
      // answer WITH our token is NEVER a winner: it is ours-healthy only
      // while the anchor/wrapper are provably alive (synchronous liveness
      // syscalls + the anchor's exit flag), else it takes the proof-checked
      // failure path.
      if (ready.launchToken === launchToken) {
        if (ourWrapperPid === undefined) {
          // Reviewer MUST-FIX (PR 97 r1): readiness arrived before identity.
          // Do NOT decide winner (and do not assume the wrapper is alive):
          // keep waiting until the anchor's spawn-time relay delivers the
          // wrapper pid (identity resolved), the attempt reaches a
          // proof-checked terminal state (child exit -> the childExited path
          // at the top of the loop), or the start cap expires (fail closed
          // via the teardown-first path below). The relay is written at
          // spawn time, long before any server can become ready, so this
          // wait is microseconds in practice; the delayed-listener false
          // green can no longer reach any success path.
          continue;
        }
        // Secondary grace (PR 96 semantics): give the anchor's loop-scheduled
        // exit event one bounded turn (bounds the wrapper-zombie window)
        // before the deterministic classification below.
        if (!childExited && child.exitCode === null && child.signalCode === null) {
          await Promise.race([
            new Promise<void>((resolve) => child.once("exit", () => resolve())),
            new Promise<void>((resolve) => setTimeout(resolve, WINNER_EXIT_GRACE_MS)),
          ]);
        }
        const anchorExitedNow = childExited || child.exitCode !== null || child.signalCode !== null;
        // Synchronous liveness syscall on the relayed wrapper pid — never a
        // guess: identity is resolved here, so "unknown" cannot occur.
        const wrapperAliveNow = pidAlive(ourWrapperPid);
        if (classifyReadyAnswer(ready.launchToken, launchToken, wrapperAliveNow, anchorExitedNow) === "ours-unproven") {
          childExited = true;
          continue;
        }
        console.log(`Action Hub daemon started (pid ${ready.pid}).`);
        return 0;
      }
      // A foreign (token-less or different-token) answer is a legitimate winner.
      console.log(`Action Hub daemon started (pid ${ready.pid}).`);
      return 0;
    }

    const now = Date.now();

    // Any sign of life resets the no-progress window.
    let progressed = false;
    const logSize = await fileSize(paths.log);
    if (logSize > lastLogSize) {
      if (lastLogSize >= 0) progressed = true; // ignore the very first read
      lastLogSize = logSize;
    }
    if (ready !== undefined) progressed = true; // state file appeared/changed
    if (progressed) lastProgressAt = now;

    if (now - lastProgressAt >= noProgressWindowMs()) break;

    if (now - lastProgressPrint >= PROGRESS_LOG_INTERVAL_MS) {
      const elapsed = Math.round((now - startedAt) / 100) / 10;
      // Surface reindex state when the daemon publishes it (PR 63 fields,
      // read best-effort from the state file).
      const indexing = await readIndexingState(paths);
      const phase = indexing === undefined ? "" : indexing ? "; reindex in progress" : "; reindex settled";
      console.log(`Waiting for Action Hub daemon... ${elapsed}s elapsed (cap ${Math.round(cap / 1000)}s)${phase}.`);
      lastProgressPrint = now;
    }
    await delay(50);
  }

  console.error(`Action Hub daemon did not become ready. See ${paths.log}`);
  // Teardown FIRST and consult the proof (same as the childExited path): the
  // orphaned server of THIS failed start must never satisfy the sibling
  // winner probe.
  const res = await killAndReapSpawned(child);
  if (!res.proven || res.survivors.length > 0) return 1;
  if (await waitForAnotherDaemon(paths)) return 0;
  return 1;
}

/**
 * Terminates and reaps the anchored daemon tree this start spawned. Called on
 * EVERY failure path before returning: a daemon that never became ready must
 * not survive its own failed start as an orphan. The host only signals the
 * ANCHOR it spawned (single-PID, always safe); the anchor performs its own
 * gated group cleanup from inside. If the anchor cannot be proven cleaned,
 * the result fails closed — no group is ever signalled on guesswork.
 */
async function killAndReapSpawned(child: ChildProcess): Promise<TeardownResult> {
  if (!child.pid) return { survivors: [], proven: false };
  const result = await teardownAnchorChild(child, 5_000);
  if (!result.proven || result.survivors.length > 0) {
    console.error(
      `Warning: daemon start teardown could not be proven (anchor pid ${child.pid}${result.survivors.length > 0 ? `, surviving: ${result.survivors.join(", ")}` : ""}).`,
    );
  }
  return result;
}

/**
 * After our own child failed to spawn or exited during startup, another
 * concurrently started daemon may still win and become ready — poll briefly
 * (bounded) before declaring failure. Returns the winning pid, if any.
 */
async function waitForAnotherDaemon(paths: DaemonPaths): Promise<number | undefined> {
  const deadline = Date.now() + CONCURRENT_START_GRACE_MS;
  for (;;) {
    const ready = await daemonReady(paths);
    if (ready?.ok) {
      console.log(`Action Hub daemon is already running (pid ${ready.pid}).`);
      return ready.pid;
    }
    if (Date.now() >= deadline) return undefined;
    await delay(100);
  }
}

export async function daemonStatusCommand(options: DaemonOptions = {}): Promise<number> {
  const paths = daemonPaths(options.daemonDir);
  try {
    const result = await probe(paths);
    if (!result.ok) throw new Error(result.error ?? "Daemon rejected the status request");
    console.log(`Action Hub daemon is running (pid ${result.state.pid}, since ${result.state.startedAt}).`);
    if (result.state.configPath) console.log(`Config: ${result.state.configPath}`);
    console.log(formatEndpoint(result.state));
    return 0;
  } catch (cause) {
    console.error(`Action Hub daemon is not running: ${message(cause)}`);
    return 1;
  }
}

export async function daemonStopCommand(options: DaemonOptions = {}): Promise<number> {
  const paths = daemonPaths(options.daemonDir);
  try {
    const { state, token } = await readCredentials(paths);
    const response = await request(state, token, "shutdown");
    if (!response["ok"]) throw new Error(String(response["error"] ?? "Daemon rejected shutdown"));

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        await lstat(paths.state);
      } catch (cause) {
        if (isCode(cause, "ENOENT")) {
          console.log("Action Hub daemon stopped.");
          return 0;
        }
        throw cause;
      }
      await delay(50);
    }
    throw new Error("Timed out waiting for the daemon to stop");
  } catch (cause) {
    console.error(`Could not stop Action Hub daemon: ${message(cause)}`);
    return 1;
  }
}

export async function connectCommand(options: DaemonOptions = {}): Promise<number> {
  const paths = daemonPaths(options.daemonDir);
  // Tracked so a handshake failure can destroy the socket before returning.
  // Without this, a daemon that accepts but never responds leaves the socket
  // open and the process hangs even after the timeout error is printed.
  let socket: Socket | undefined;
  try {
    const { state, token } = await readCredentials(paths);
    socket = await openSocket(state);
    socket.write(`${JSON.stringify({ token, command: "mcp" })}\n`);
    const response = await readLine(socket);
    const parsed = JSON.parse(response) as Record<string, unknown>;
    if (!parsed["ok"]) throw new Error(String(parsed["error"] ?? "Daemon rejected the connection"));
  } catch (cause) {
    socket?.destroy();
    process.stderr.write(`action-hub: could not connect to daemon: ${message(cause)}\n`);
    return 1;
  }

  process.stdin.pipe(socket);
  socket.pipe(process.stdout);

  return new Promise<number>((done) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      // Drop the pipe handles so the event loop can wind down after the socket
      // closes; without this the flowing stdin pipe keeps the process alive.
      process.stdin.unpipe(socket);
      socket.destroy();
      if (process.stdin.readable) process.stdin.destroy();
      done(code);
    };
    socket.once("close", () => finish(0));
    socket.once("error", (cause) => {
      process.stderr.write(`action-hub: daemon connection failed: ${cause.message}\n`);
      finish(1);
    });
    process.stdin.once("error", () => socket.destroy());
  });
}

export async function runDaemonProcess(): Promise<void> {
  await runDaemonServer();
}

function daemonChildArgs(entryOverride?: string): string[] {
  const entry = entryOverride ?? process.argv[1];
  if (!entry || resolve(entry) === resolve(process.execPath)) return ["__daemon-run"];
  return [entry, "__daemon-run"];
}

async function probe(
  paths: DaemonPaths,
): Promise<{ ok: boolean; state: DaemonState; error?: string }> {
  const { state, token } = await readCredentials(paths);
  const response = await request(state, token, "status");
  return {
    ok: response["ok"] === true,
    state,
    error: typeof response["error"] === "string" ? response["error"] : undefined,
  };
}

async function request(
  state: DaemonState,
  token: string,
  command: "status" | "shutdown",
): Promise<Record<string, unknown>> {
  const socket = await openSocket(state);
  try {
    socket.write(`${JSON.stringify({ token, command })}\n`);
    return JSON.parse(await readLine(socket)) as Record<string, unknown>;
  } finally {
    socket.destroy();
  }
}

async function readCredentials(paths: DaemonPaths): Promise<{ state: DaemonState; token: string }> {
  await Promise.all([assertPrivate(paths.state), assertPrivate(paths.token)]);
  const [stateText, tokenText] = await Promise.all([
    readFile(paths.state, "utf8"),
    readFile(paths.token, "utf8"),
  ]);
  const state = JSON.parse(stateText) as DaemonState;
  if (state.version !== 1 || !Number.isSafeInteger(state.pid) || !state.endpoint) {
    throw new Error(`Invalid daemon state at ${paths.state}`);
  }
  const token = tokenText.trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error(`Invalid daemon token at ${paths.token}`);
  return { state, token };
}

async function assertPrivate(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Refusing unsafe daemon state file: ${path}`);
  }
  if (platform() !== "win32") {
    if ((info.mode & 0o077) !== 0) throw new Error(`Daemon state file has unsafe permissions: ${path}`);
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error(`Daemon state file is not owned by the current user: ${path}`);
    }
  }
}

async function openSocket(state: DaemonState): Promise<Socket> {
  return new Promise<Socket>((done, fail) => {
    const socket =
      state.endpoint.kind === "unix"
        ? connect(state.endpoint.path)
        : connect(state.endpoint.port, state.endpoint.host);
    const timer = setTimeout(() => {
      socket.destroy();
      fail(new Error("Timed out connecting to the Action Hub daemon"));
    }, REQUEST_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      done(socket);
    });
    socket.once("error", (cause) => {
      clearTimeout(timer);
      fail(cause);
    });
  });
}

async function readLine(socket: Socket): Promise<string> {
  return new Promise<string>((done, fail) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      fail(new Error("Timed out waiting for the Action Hub daemon"));
    }, REQUEST_TIMEOUT_MS);
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };
    const onError = (cause: Error): void => {
      cleanup();
      fail(cause);
    };
    const onClose = (): void => {
      cleanup();
      fail(new Error("Action Hub daemon closed the connection"));
    };
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_RESPONSE_BYTES) {
        cleanup();
        fail(new Error("Action Hub daemon response was too large"));
        return;
      }
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      const remainder = buffered.subarray(newline + 1);
      cleanup();
      if (remainder.length > 0) socket.unshift(remainder);
      done(buffered.subarray(0, newline).toString("utf8"));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function daemonPaths(customDir?: string): DaemonPaths {
  const dir = resolve(customDir ?? defaultDaemonDir());
  return {
    dir,
    state: join(dir, "daemon.json"),
    token: join(dir, "auth-token"),
    log: join(dir, "daemon.log"),
  };
}

function formatEndpoint(state: DaemonState): string {
  return state.endpoint.kind === "unix"
    ? `Endpoint: ${state.endpoint.path}`
    : `Endpoint: ${state.endpoint.host}:${state.endpoint.port}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isCode(cause: unknown, code: string): boolean {
  return (cause as NodeJS.ErrnoException).code === code;
}
