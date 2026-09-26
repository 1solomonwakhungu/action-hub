import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { chmod, lstat, mkdir, readFile } from "node:fs/promises";import { connect, type Socket } from "node:net";
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
}

/** Isolated readiness predicate: a single place to change the readiness signal. */
async function daemonReady(
  paths: DaemonPaths,
): Promise<{ ok: boolean; pid?: number } | undefined> {
  const result = await probe(paths).catch(() => undefined);
  if (!result) return undefined;
  return { ok: result.ok, pid: result.state?.pid };
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
  const env = {
    ...process.env,
    ACTION_HUB_DAEMON_DIR: paths.dir,
    ...(options.configPath ? { ACTION_HUB_CONFIG: resolvePath(options.configPath) } : {}),
  };
  let spawnError: Error | undefined;
  const child = spawn(process.execPath, daemonChildArgs(options.entryPath), {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env,
  });
  child.once("error", (cause) => {
    spawnError = cause;
  });
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
    if (spawnError) {
      // Another concurrent start may have won the race even though ours
      // failed to spawn — report success if a daemon is already ready.
      if (await waitForAnotherDaemon(paths)) {
        return 0;
      }
      console.error(`Could not start Action Hub daemon: ${spawnError.message}`);
      return 1;
    }
    if (childExited) {
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
    if (ready?.ok) {
      console.log(`Action Hub daemon started (pid ${ready.pid}).`);
      return 0;
    }

    const now = Date.now();
    if (now >= totalDeadline) break;

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
  if (await waitForAnotherDaemon(paths)) return 0;
  return 1;
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
