import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Regression tests for the test-isolation preload (F20), per the revised
// /tmp/action-hub-stress/ISOLATION.md. Each test spawns a fresh node process
// with the preload and hostile env, and asserts the preload made the
// environment safe.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const preload = join(repoRoot, "test-isolation.mjs");

// The complete isolation checklist (ISOLATION.md). Path-bearing vars that must
// all end up inside ONE fresh temp root.
export const CHECKLIST = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_DATA_HOME",
  "ACTION_HUB_CONFIG",
  "ACTION_HUB_CACHE",
  "ACTION_HUB_SKILLS_DIR",
  "ACTION_HUB_DAEMON_DIR",
  "ACTION_HUB_CREDENTIALS",
  "ACTION_HUB_CONTROL",
  "PI_CODING_AGENT_DIR",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
] as const;

// env values of `undefined` delete the variable for the child (the helper
// builds the child env from the parent's, applying deletions explicitly).
function runIsolated(env: Record<string, string | undefined>, code: string): ReturnType<typeof spawnSync> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[name];
    else childEnv[name] = value;
  }
  return spawnSync(process.execPath, ["--import", preload, "-e", code], {
    env: childEnv,
    encoding: "utf8",
    timeout: 60_000,
  });
}

const DUMP_ENV = `process.stdout.write(JSON.stringify(${JSON.stringify(CHECKLIST)}.map(n => [n, process.env[n]])))`;

test("every checklist variable is replaced and lands inside one fresh temp root", () => {
  const sentinels: Record<string, string> = {};
  for (const name of CHECKLIST) sentinels[name] = `/pr60r3-sentinel/${name.toLowerCase()}`;
  const res = runIsolated(sentinels, DUMP_ENV);
  assert.equal(res.status, 0, res.stderr);
  const values = JSON.parse(res.stdout) as Array<[string, string]>;
  const roots = new Set(values.map(([, v]) => v.split("/").slice(0, 3).join("/")));
  for (const [name, value] of values) {
    assert.ok(value.length > 0, `${name} must be set`);
    assert.ok(value.includes("action-hub-test-home-"), `${name}=${value} must live in the per-process temp root`);
    assert.ok(!value.startsWith("/pr60r3-sentinel"), `${name} must not survive the preload`);
  }
  // One temp root for all of them.
  const homes = new Set(values.map(([, v]) => v.split("action-hub-test-home-")[0]));
  assert.equal(homes.size, 1, "all checklist values must share one temp root");
});

test("an explicit sentinel ACTION_HUB_CACHE cannot survive the preload", () => {
  const sentinelRoot = join(tmpdir(), "pr60-owner-sentinel");
  const sentinelCache = join(sentinelRoot, ".cache/action-hub/catalog.json");
  const res = runIsolated(
    { ACTION_HUB_CACHE: sentinelCache },
    'process.stdout.write(process.env["ACTION_HUB_CACHE"])',
  );
  assert.equal(res.status, 0, res.stderr);
  assert.ok(!res.stdout.includes("pr60-owner-sentinel"), "sentinel cache path survived the preload");
  assert.match(res.stdout, /action-hub-test-home-/);
});

test("the mandated owner-state invocation (one temp HOME + XDG + daemon dir) is safe to nest", () => {
  const root = join(tmpdir(), "pr60-mandated-invocation");
  const res = runIsolated(
    {
      HOME: root,
      XDG_CACHE_HOME: join(root, ".cache"),
      XDG_CONFIG_HOME: join(root, ".config"),
      XDG_STATE_HOME: join(root, ".local/state"),
      XDG_DATA_HOME: join(root, ".local/share"),
      ACTION_HUB_DAEMON_DIR: join(root, "daemon"),
    },
    'process.stdout.write([process.env["HOME"], process.env["ACTION_HUB_DAEMON_DIR"]].join("|"))',
  );
  assert.equal(res.status, 0, res.stderr);
  const [home, daemonDir] = res.stdout.split("|");
  assert.match(home!, /action-hub-test-home-/);
  assert.match(daemonDir!, /action-hub-test-home-/);
});

test("Windows-shaped env: tmpdir beneath USERPROFILE with all checklist values under it is accepted", () => {
  const userProfile = join(tmpdir(), "pr60-windows-shaped-profile");
  const temp = join(userProfile, "AppData/Local/Temp"); // os.tmpdir() under USERPROFILE
  const res = runIsolated(
    {
      USERPROFILE: userProfile,
      HOME: userProfile,
      APPDATA: join(userProfile, "AppData/Roaming"),
      LOCALAPPDATA: temp,
      TMPDIR: temp,
      TMP: temp,
      TEMP: temp,
      XDG_CACHE_HOME: join(temp, "cache"),
      XDG_CONFIG_HOME: join(temp, "config"),
      XDG_STATE_HOME: join(temp, "state"),
      XDG_DATA_HOME: join(temp, "share"),
      ACTION_HUB_CACHE: join(temp, "cache/action-hub/catalog.json"),
      ACTION_HUB_DAEMON_DIR: join(temp, "daemon"),
    },
    'process.stdout.write(process.env["ACTION_HUB_CACHE"])',
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /action-hub-test-home-/);
});

test("the preload still detects the real home when HOME is unset (Windows-style)", () => {
  const sentinelRoot = join(tmpdir(), "pr60-userprofile-sentinel");
  const res = runIsolated(
    { USERPROFILE: sentinelRoot, HOME: undefined },
    'process.stdout.write([process.env["ACTION_HUB_TEST_REAL_HOME"], process.env["ACTION_HUB_TEST_INCOMING_HOME_UNSET"]].join("|"))',
  );
  assert.equal(res.status, 0, res.stderr);
  const [realHome, incomingUnset] = res.stdout.split("|");
  assert.ok(realHome!.length > 0, "real home must be recorded even without HOME");
  assert.ok(!realHome!.includes("pr60-userprofile-sentinel"), "USERPROFILE sentinel must not be treated as the real home");
  assert.equal(incomingUnset, "1", "the child must have actually seen HOME absent before the preload ran");
});

test("a config pinned inside the owner's app-state fails fast; inherited overrides are always replaced", () => {
  // Ask the preload itself for the derived real home.
  const probe = runIsolated({}, 'process.stdout.write(process.env["ACTION_HUB_TEST_REAL_HOME"])');
  assert.equal(probe.status, 0, probe.stderr);
  const realHome = probe.stdout;
  const bad = runIsolated(
    { ACTION_HUB_CONFIG: join(realHome, ".config/action-hub/servers.json") },
    "process.exit(0)",
  );
  assert.notEqual(bad.status, 0, "a config inside the owner's app-state must fail fast");
  assert.match(bad.stderr, /resolves inside the owner's app-state/);

  // A config in a plain temp dir (outside the owner app-state) is STILL
  // replaced with a per-process temp path — inherited overrides are never
  // trusted (fail-closed).
  const outside = join(tmpdir(), "pr60-outside-config.json");
  const good = runIsolated(
    { ACTION_HUB_CONFIG: outside },
    'process.stdout.write(process.env["ACTION_HUB_CONFIG"])',
  );
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /action-hub-test-home-/);
  assert.ok(!good.stdout.includes("pr60-outside-config.json"), "inherited config override must not survive the preload");
});

test("a hostile TMPDIR under the owner's app-state is refused before anything is created", () => {
  const fakeOwner = join(tmpdir(), `pr60r4-fake-owner-${process.pid}`);
  const hostileTemp = join(fakeOwner, ".cache/action-hub");
  const res = runIsolated(
    { ACTION_HUB_TEST_REAL_HOME: fakeOwner, TMPDIR: hostileTemp, TMP: undefined, TEMP: undefined },
    "process.exit(0)",
  );
  assert.notEqual(res.status, 0, "a hostile OS temp location must be refused");
  assert.match(res.stderr, /resolves inside the owner's app-state/);
  // The refusal must happen BEFORE any directory creation.
  assert.ok(!existsSync(hostileTemp), "the preload must not create the hostile temp dir");
  assert.ok(!existsSync(join(fakeOwner)), "the preload must not create anything under the fake owner root");
});

test("TMPDIR/TMP/TEMP are repointed into the run root for descendants", () => {
  const res = runIsolated(
    { TMPDIR: tmpdir(), TMP: tmpdir(), TEMP: tmpdir() },
    'process.stdout.write(JSON.stringify([process.env["TMPDIR"], process.env["TMP"], process.env["TEMP"]]))',
  );
  assert.equal(res.status, 0, res.stderr);
  for (const value of JSON.parse(res.stdout)) {
    assert.match(value!, /action-hub-test-home-.*\/tmp$/, "descendant temp must live in the run root");
    assert.ok(!value!.startsWith(tmpdir()) || value!.includes("action-hub-test-home-"), "must not reuse the inherited temp");
  }
});
