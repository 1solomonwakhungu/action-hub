import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  daemonStartCommand,
  daemonStatusCommand,
  daemonStopCommand,
} from "../dist/commands/daemon.js";

// F20 guard: the daemon test flow (catalog persistence, snapshot writes,
// config discovery) must never touch the real user's home. The test
// preload (test-isolation.mjs) records the pre-isolation home in
// ACTION_HUB_TEST_REAL_HOME and the pre-isolation ACTION_HUB_CACHE in
// ACTION_HUB_TEST_REAL_CACHE; we fingerprint the real cache/config/skills
// locations (including directory entries and absence), run the same daemon
// lifecycle the leaking test used, and assert the fingerprints are identical.

const realHome = process.env["ACTION_HUB_TEST_REAL_HOME"];
const realCache = process.env["ACTION_HUB_TEST_REAL_CACHE"];
const testDir = dirname(fileURLToPath(import.meta.url));
const cliScript = resolve(testDir, "../dist/index.js");
const fixture = resolve(testDir, "fixtures/counting-mcp.mjs");

function containedIn(child: string, root: string): boolean {
  if (!child || !root) return false;
  const rel = relative(resolve(root), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function insideRealHome(p) {
  return containedIn(p, realHome ?? "");
}

type Snapshot = Map<
  string,
  { kind: "dir"; mtimeMs: number } | { kind: "file"; mtimeMs: number; size: number; hash?: string }
>;

async function snapshotTree(path: string, into: Snapshot): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return; // absent — recorded as absent by not being in the map
  }
  if (!insideRealHome(path)) return; // never fingerprint anything outside the real home
  if (info.isDirectory()) {
    into.set(resolve(path), { kind: "dir", mtimeMs: info.mtimeMs });
    for (const entry of await readdir(path, { withFileTypes: true })) {
      await snapshotTree(join(path, entry.name), into);
    }
  } else {
    const file: { kind: "file"; mtimeMs: number; size: number; hash?: string } = {
      kind: "file",
      mtimeMs: info.mtimeMs,
      size: info.size,
    };
    if (info.size <= 4 * 1024 * 1024) {
      file.hash = createHash("sha256").update(await readFile(path)).digest("hex");
    }
    into.set(resolve(path), file);
  }
}

async function fingerprintRealHome(): Promise<Snapshot> {
  const snap: Snapshot = new Map();
  for (const dir of [
    join(realHome!, ".cache", "action-hub"),
    join(realHome!, ".config", "action-hub"),
    join(realHome!, ".action-hub"),
  ]) {
    await snapshotTree(dir, snap);
  }
  // An explicit ACTION_HUB_CACHE inherited from the shell may point anywhere
  // in the real home; fingerprint it too when the preload recorded one.
  if (realCache && insideRealHome(realCache)) {
    await snapshotTree(realCache, snap);
  }
  return snap;
}

test("the daemon flow never touches the owner's real home state", async () => {
  if (!realHome || !insideRealHome(realHome)) {
    // Running without the isolation preload: this guard only means
    // something when the real home was recorded before isolation.
    return;
  }
  assert.ok(!insideRealHome(process.env["HOME"] ?? ""), "this process must run isolated");
  for (const name of [
    "ACTION_HUB_CACHE",
    "ACTION_HUB_CREDENTIALS",
    "ACTION_HUB_CONFIG",
    "ACTION_HUB_SKILLS_DIR",
    "ACTION_HUB_DAEMON_DIR",
  ]) {
    assert.ok(!insideRealHome(process.env[name] ?? ""), `${name} must not resolve inside the real home`);
  }

  const before = await fingerprintRealHome();

  const root = join(tmpdir(), `action-hub-owner-guard-${Date.now()}-${process.pid}`);
  const daemonDir = join(root, "runtime");
  const configPath = join(root, "servers.json");
  const countFile = join(root, "spawn-count");
  await mkdir(daemonDir, { recursive: true, mode: 0o700 });
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

  // The complete ISOLATION.md checklist, all under ONE lifecycle root.
  const previous = [
    "ACTION_HUB_DAEMON_DIR",
    "ACTION_HUB_CONFIG",
    "ACTION_HUB_SKILLS_DIR",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_DATA_HOME",
    "ACTION_HUB_CACHE",
    "ACTION_HUB_CREDENTIALS",
    "ACTION_HUB_CONTROL",
    "PI_CODING_AGENT_DIR",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "TMPDIR",
    "TMP",
    "TEMP",
  ].map((name) => [name, process.env[name]] as const);
  const lifecycle = {
    ACTION_HUB_DAEMON_DIR: daemonDir,
    ACTION_HUB_CONFIG: configPath,
    ACTION_HUB_SKILLS_DIR: join(root, "skills"),
    HOME: root,
    USERPROFILE: root,
    APPDATA: join(root, "AppData", "Roaming"),
    LOCALAPPDATA: join(root, "AppData", "Local"),
    XDG_CACHE_HOME: join(root, ".cache"),
    XDG_CONFIG_HOME: join(root, ".config"),
    XDG_STATE_HOME: join(root, ".local", "state"),
    XDG_DATA_HOME: join(root, ".local", "share"),
    ACTION_HUB_CACHE: join(root, ".cache", "action-hub", "catalog.json"),
    ACTION_HUB_CREDENTIALS: join(root, ".local", "state", "credentials.json"),
    ACTION_HUB_CONTROL: join(root, "control.json"),
    PI_CODING_AGENT_DIR: join(root, "pi"),
    CODEX_HOME: join(root, ".codex"),
    CLAUDE_CONFIG_DIR: join(root, ".claude"),
    TMPDIR: join(root, "tmp"),
    TMP: join(root, "tmp"),
    TEMP: join(root, "tmp"),
  };
  // Validate the FINAL values before constructing or spawning anything.
  for (const [name, value] of Object.entries(lifecycle)) {
    assert.ok(
      containedIn(value, root),
      `${name}=${value} is not contained in the lifecycle root ${root}`,
    );
  }
  for (const [name, value] of Object.entries(lifecycle)) {
    process.env[name] = value;
  }

  try {
    assert.equal(await daemonStartCommand({ daemonDir, configPath, entryPath: cliScript }), 0);
    assert.equal(await daemonStatusCommand({ daemonDir }), 0);
    assert.equal(await daemonStopCommand({ daemonDir }), 0);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }

  const after = await fingerprintRealHome();
  assert.deepEqual(
    [...after.entries()],
    [...before.entries()],
    "the daemon flow modified the real user's home state",
  );
});

// F20 regression: running the daemon test DIRECTLY (no preload, `node --test
// packages/cli/test/daemon.test.ts`) with hostile sentinel overrides must not
// write any of them — daemon.test.ts pins the complete ISOLATION.md checklist
// itself.
test("a direct no-preload daemon test run with hostile sentinels writes none of them", async () => {
  const sentinelRoot = join(tmpdir(), `pr60r3-direct-sentinel-${process.pid}`);
  const sentinels: Record<string, string> = {
    ACTION_HUB_CACHE: join(sentinelRoot, "catalog.json"),
    ACTION_HUB_CREDENTIALS: join(sentinelRoot, "credentials.json"),
    ACTION_HUB_CONTROL: join(sentinelRoot, "control.json"),
    XDG_STATE_HOME: join(sentinelRoot, "state"),
    XDG_DATA_HOME: join(sentinelRoot, "data"),
    PI_CODING_AGENT_DIR: join(sentinelRoot, "pi"),
    CODEX_HOME: join(sentinelRoot, "codex"),
    CLAUDE_CONFIG_DIR: join(sentinelRoot, "claude"),
  };
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...sentinels };
  // Run without the preload: plain node --test of the daemon suite.
  const res = spawnSync(
    process.execPath,
    ["--test", join(testDir, "daemon.test.ts")],
    { env: childEnv, encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(res.status, 0, `daemon test failed without preload:\n${res.stderr}`);
  const { existsSync } = await import("node:fs");
  for (const [name, path] of Object.entries(sentinels)) {
    assert.ok(!existsSync(path), `${name}=${path} was written by the unpreloaded run`);
  }
  await rm(sentinelRoot, { recursive: true, force: true });
});
