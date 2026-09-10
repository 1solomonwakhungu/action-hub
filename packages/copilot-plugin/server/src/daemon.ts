import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { homedir, platform, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { connectMcpClient, createHubRuntime, type HubRuntime } from "./index.js";

const AUTH_TIMEOUT_MS = 5_000;
const MAX_AUTH_BYTES = 8 * 1024;
const STATE_VERSION = 1;

interface DaemonState {
  version: number;
  pid: number;
  startedAt: string;
  configPath?: string;
  endpoint:
    | { kind: "unix"; path: string }
    | { kind: "tcp"; host: "127.0.0.1"; port: number };
}

interface AuthRequest {
  token?: unknown;
  command?: unknown;
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

export async function runDaemon(): Promise<void> {
  const paths = daemonPaths(defaultDaemonDir());
  await secureDirectory(paths.dir);
  if (paths.socketDir !== paths.dir) await secureDirectory(paths.socketDir);
  const lock = await acquireLock(paths.lock);
  let runtime: HubRuntime | undefined;
  let listener: NetServer | undefined;
  const clients = new Set<McpServer>();
  let stopping = false;

  const cleanup = async (): Promise<void> => {
    await Promise.allSettled([...clients].map((client) => client.close()));
    clients.clear();
    if (listener?.listening) {
      await new Promise<void>((done) => listener!.close(() => done()));
    }
    await runtime?.close();
    await Promise.all([
      rm(paths.state, { force: true }),
      rm(paths.token, { force: true }),
      rm(paths.socket, { force: true }),
    ]);
    if (paths.socketDir !== paths.dir) {
      await rm(paths.socketDir, { recursive: true, force: true });
    }
    await lock.close();
    await rm(paths.lock, { force: true });
  };

  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await cleanup();
  };

  try {
    await removeStaleArtifacts(paths);
    const token = randomBytes(32).toString("hex");
    await writePrivate(paths.token, `${token}\n`);

    runtime = await createHubRuntime();
    listener = createServer((socket) => {
      authenticate(socket, token, async (command) => {
        if (command === "status") {
          socket.end(`${JSON.stringify({ ok: true, pid: process.pid })}\n`);
          return;
        }
        if (command === "shutdown") {
          socket.end(`${JSON.stringify({ ok: true, stopping: true })}\n`);
          setImmediate(() => void shutdown());
          return;
        }
        if (command !== "mcp") {
          socket.end(`${JSON.stringify({ ok: false, error: "Unknown daemon command" })}\n`);
          return;
        }

        socket.write(`${JSON.stringify({ ok: true })}\n`);
        const transport = new StdioServerTransport(socket, socket);
        const client = await connectMcpClient(runtime!, transport);
        clients.add(client);
        socket.once("close", () => {
          clients.delete(client);
          void client.close().catch(() => undefined);
        });
      });
    });

    const endpoint = await listen(listener, paths.socket);
    const state: DaemonState = {
      version: STATE_VERSION,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      configPath: runtime.configPath,
      endpoint,
    };
    await writePrivateJson(paths.state, state);

    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    await new Promise<void>((done, fail) => {
      listener!.once("close", done);
      listener!.once("error", fail);
    });
  } catch (cause) {
    await cleanup().catch(() => undefined);
    throw cause;
  }
}

function authenticate(
  socket: Socket,
  expectedToken: string,
  onAuthorized: (command: string) => Promise<void>,
): void {
  let buffered = Buffer.alloc(0);
  const timer = setTimeout(() => reject("Authentication timed out"), AUTH_TIMEOUT_MS);

  const reject = (reason: string): void => {
    clearTimeout(timer);
    socket.removeListener("data", onData);
    socket.end(`${JSON.stringify({ ok: false, error: reason })}\n`);
  };

  const onData = (chunk: Buffer): void => {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length > MAX_AUTH_BYTES) {
      reject("Authentication request too large");
      return;
    }

    const newline = buffered.indexOf(0x0a);
    if (newline < 0) return;
    clearTimeout(timer);
    socket.removeListener("data", onData);
    socket.pause();

    let request: AuthRequest;
    try {
      request = JSON.parse(buffered.subarray(0, newline).toString("utf8")) as AuthRequest;
    } catch {
      reject("Invalid authentication request");
      return;
    }

    if (!validToken(request.token, expectedToken)) {
      reject("Unauthorized");
      return;
    }

    void onAuthorized(typeof request.command === "string" ? request.command : "")
      .catch((cause: unknown) => {
        socket.end(
          `${JSON.stringify({
            ok: false,
            error: cause instanceof Error ? cause.message : String(cause),
          })}\n`,
        );
      })
      .finally(() => socket.resume());
  };

  socket.on("data", onData);
  socket.once("error", () => clearTimeout(timer));
}

function validToken(value: unknown, expected: string): boolean {
  if (typeof value !== "string") return false;
  const actualBytes = Buffer.from(value);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

async function listen(
  server: NetServer,
  socketPath: string,
): Promise<DaemonState["endpoint"]> {
  if (platform() === "win32") {
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
        server.removeListener("error", fail);
        done();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Daemon failed to bind its localhost endpoint");
    }
    return { kind: "tcp", host: "127.0.0.1", port: address.port };
  }

  await rm(socketPath, { force: true });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(socketPath, () => {
      server.removeListener("error", fail);
      done();
    });
  });
  await chmod(socketPath, 0o600);
  return { kind: "unix", path: socketPath };
}

async function acquireLock(path: string): Promise<FileHandle> {
  const reapPath = `${path}.reap`;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      return handle;
    } catch (cause) {
      if (!isCode(cause, "EEXIST")) throw cause;

      let reaper: FileHandle | undefined;
      try {
        reaper = await open(reapPath, "wx", 0o600);
        await reaper.writeFile(`${process.pid}\n`, "utf8");
      } catch (reapCause) {
        if (!isCode(reapCause, "EEXIST")) throw reapCause;
        let reaperOwner = await readPid(reapPath);
        if (reaperOwner === undefined) {
          await delay(50);
          reaperOwner = await readPid(reapPath);
        }
        if (reaperOwner === undefined || !processAlive(reaperOwner)) {
          await rm(reapPath, { force: true });
        }
        await delay(25);
        continue;
      }

      try {
        let owner = await readPid(path);
        if (owner === undefined) {
          await delay(50);
          owner = await readPid(path);
        }
        if (owner !== undefined && processAlive(owner)) {
          throw new Error(`Action Hub daemon is already running (pid ${owner})`);
        }
        await rm(path, { force: true });
      } finally {
        await reaper.close();
        await rm(reapPath, { force: true });
      }
    }
  }
  throw new Error("Could not acquire the Action Hub daemon lock");
}

async function removeStaleArtifacts(paths: ReturnType<typeof daemonPaths>): Promise<void> {
  let staleSocket: string | undefined;
  try {
    const stale = JSON.parse(await readFile(paths.state, "utf8")) as Partial<DaemonState>;
    if (
      stale.endpoint?.kind === "unix" &&
      (stale.endpoint.path === paths.socket || dirname(stale.endpoint.path) === paths.dir)
    ) {
      staleSocket = stale.endpoint.path;
    }
  } catch {
    // Invalid stale state is removed below.
  }
  await Promise.all([
    rm(paths.state, { force: true }),
    rm(paths.token, { force: true }),
    rm(paths.socket, { force: true }),
    ...(staleSocket && staleSocket !== paths.socket ? [rm(staleSocket, { force: true })] : []),
  ]);
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (platform() === "win32") return;
  await chmod(path, 0o700);
  const info = await stat(path);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`Daemon directory is not owned by the current user: ${path}`);
  }
}

async function writePrivate(path: string, content: string): Promise<void> {
  const temp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writePrivate(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readPid(path: string): Promise<number | undefined> {
  try {
    const value = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return isCode(cause, "EPERM");
  }
}

function daemonPaths(dir: string) {
  const directSocket = join(dir, "daemon.sock");
  const socketDir =
    platform() !== "win32" && Buffer.byteLength(directSocket) >= 100
      ? join(
          platform() === "darwin" ? "/tmp" : tmpdir(),
          `action-hub-${typeof process.getuid === "function" ? process.getuid() : userInfo().username}-${createHash("sha256").update(dir).digest("hex").slice(0, 12)}`,
        )
      : dir;
  return {
    dir,
    socketDir,
    lock: join(dir, "daemon.lock"),
    state: join(dir, "daemon.json"),
    token: join(dir, "auth-token"),
    socket: join(socketDir, "daemon.sock"),
  };
}

function isCode(cause: unknown, code: string): boolean {
  return (cause as NodeJS.ErrnoException).code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}
