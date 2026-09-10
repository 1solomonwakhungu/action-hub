import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  daemonStartCommand,
  daemonStatusCommand,
  daemonStopCommand,
} from "../dist/commands/daemon.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const cliScript = resolve(testDir, "../dist/index.js");
const fixture = resolve(testDir, "fixtures/counting-mcp.mjs");

test("daemon shares one hub across authenticated clients and recovers stale state", async () => {
  const root = await makeTempDir();
  const daemonDir = join(root, "runtime");
  const configPath = join(root, "servers.json");
  const countFile = join(root, "spawn-count");
  const env = stringEnv({
    ...process.env,
    ACTION_HUB_DAEMON_DIR: daemonDir,
    ACTION_HUB_CONFIG: configPath,
  });

  await mkdir(daemonDir, { recursive: true, mode: 0o700 });
  await writePrivate(join(daemonDir, "daemon.lock"), "99999999\n");
  await writePrivate(join(daemonDir, "daemon.lock.reap"), "99999998\n");
  await writePrivate(join(daemonDir, "daemon.json"), JSON.stringify({
    version: 1,
    pid: 99999999,
    startedAt: new Date(0).toISOString(),
    endpoint: { kind: "unix", path: join(daemonDir, "daemon.sock") },
  }));
  await writePrivate(join(daemonDir, "auth-token"), "0".repeat(64));
  await writePrivate(join(daemonDir, "daemon.sock"), "stale");
  await writeFile(
    configPath,
    JSON.stringify({
      autoDiscover: false,
      autoApproveAtOrAbove: "trusted",
      servers: [
        {
          id: "counting",
          trust: "trusted",
          transport: {
            type: "stdio",
            command: process.execPath,
            args: [fixture],
            env: { COUNT_FILE: countFile },
          },
        },
      ],
    }),
    "utf8",
  );

  const previousDir = process.env["ACTION_HUB_DAEMON_DIR"];
  const previousConfig = process.env["ACTION_HUB_CONFIG"];
  process.env["ACTION_HUB_DAEMON_DIR"] = daemonDir;
  process.env["ACTION_HUB_CONFIG"] = configPath;

  const clients: Client[] = [];
  try {
    const starts = await Promise.all([
      daemonStartCommand({ daemonDir, configPath }),
      daemonStartCommand({ daemonDir, configPath }),
    ]);
    assert.deepEqual(starts, [0, 0]);
    assert.equal(await daemonStatusCommand({ daemonDir }), 0);

    if (process.platform !== "win32") {
      assert.equal((await stat(daemonDir)).mode & 0o077, 0);
      assert.equal((await stat(join(daemonDir, "daemon.json"))).mode & 0o077, 0);
      assert.equal((await stat(join(daemonDir, "auth-token"))).mode & 0o077, 0);
    }

    const state = JSON.parse(await readFile(join(daemonDir, "daemon.json"), "utf8"));
    if (process.platform !== "win32") {
      assert.equal((await stat(state.endpoint.path)).mode & 0o077, 0);
    }
    const rejection = await unauthorized(state.endpoint);
    assert.equal(rejection.ok, false);
    assert.equal(rejection.error, "Unauthorized");

    clients.push(await connectClient("client-a", env), await connectClient("client-b", env));
    await waitForAction(clients[0]!);

    const results = await Promise.all([
      callHub(clients[0]!, "client-a"),
      callHub(clients[1]!, "client-b"),
    ]);
    assert.deepEqual(results.sort(), ["client-a", "client-b"]);

    const downstreamPids = (await readFile(countFile, "utf8")).trim().split("\n");
    assert.equal(downstreamPids.length, 1, "both clients must share one downstream process");

    await Promise.all(clients.splice(0).map((client) => client.close()));
    assert.equal(await daemonStopCommand({ daemonDir }), 0);
    await assert.rejects(readFile(join(daemonDir, "daemon.json"), "utf8"), { code: "ENOENT" });
    if (state.endpoint.kind === "unix") {
      await assert.rejects(stat(state.endpoint.path), { code: "ENOENT" });
    }
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    try {
      await readFile(join(daemonDir, "daemon.json"), "utf8");
      await daemonStopCommand({ daemonDir });
    } catch {
      // The normal assertion path already stopped and removed the daemon.
    }
    restoreEnv("ACTION_HUB_DAEMON_DIR", previousDir);
    restoreEnv("ACTION_HUB_CONFIG", previousConfig);
    await rm(root, { recursive: true, force: true });
  }
});

async function connectClient(name: string, env: Record<string, string>): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [cliScript, "connect"],
    env,
    stderr: "pipe",
  }));
  return client;
}

async function waitForAction(client: Client): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await client.callTool({
      name: "action_hub",
      arguments: { operation: "search", query: "ping" },
    });
    const payload = hubPayload(response);
    if (payload.count === 1) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("Timed out waiting for the daemon catalog");
}

async function callHub(client: Client, clientId: string): Promise<string> {
  const response = await client.callTool({
    name: "action_hub",
    arguments: {
      operation: "execute",
      action_id: "counting:ping",
      arguments: { client: clientId },
    },
  });
  const payload = hubPayload(response);
  assert.equal(payload.ok, true);
  const content = payload.content as Array<{ type: string; text: string }>;
  return content[0]!.text;
}

function hubPayload(response: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = response.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

async function unauthorized(endpoint: { kind: "unix"; path: string } | { kind: "tcp"; host: string; port: number }) {
  const socket = await new Promise<ReturnType<typeof connect>>((done, fail) => {
    const candidate = endpoint.kind === "unix" ? connect(endpoint.path) : connect(endpoint.port, endpoint.host);
    candidate.once("connect", () => done(candidate));
    candidate.once("error", fail);
  });
  socket.write(`${JSON.stringify({ token: "bad-token", command: "status" })}\n`);
  let response = "";
  for await (const chunk of socket) response += chunk.toString();
  return JSON.parse(response.trim()) as { ok: boolean; error: string };
}

async function makeTempDir(): Promise<string> {
  const path = resolve(tmpdir(), `action-hub-daemon-test-${process.pid}-${Date.now()}`);
  await mkdir(path, { recursive: true, mode: 0o700 });
  return path;
}

async function writePrivate(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await chmod(path, 0o600);
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
