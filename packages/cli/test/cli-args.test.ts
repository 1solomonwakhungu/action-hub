import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const cliBin = resolve(testDir, "../dist/index.js");

async function withTempConfig<T>(fn: (dir: string, cfgPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ah-cli-args-"));
  const cfgPath = join(dir, "servers.json");
  await writeFile(cfgPath, JSON.stringify({ servers: [], autoDiscover: false }), "utf8");
  try {
    return await fn(dir, cfgPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runCli(args: string[], dir: string) {
  return spawnSync("node", [cliBin, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: dir, ACTION_HUB_SKILLS_DIR: join(dir, "skills") },
    timeout: 60_000,
  });
}

// A bare `--config` (no value) was parsed as `true`, dropped, and the command
// ran against the DEFAULT config path as if the flag had never been given.
test("a valueless --config exits 1 on stderr instead of silently using the default config", async () => {
  await withTempConfig(async (dir) => {
    for (const args of [["list", "--config"], ["list", "--config", "--kind", "skill"]]) {
      const res = runCli(args, dir);
      assert.equal(res.status, 1, `${args.join(" ")}: ${res.stdout}${res.stderr}`);
      assert.equal(res.stdout, "", "nothing on stdout");
      assert.match(res.stderr, /Missing value for --config/);
    }
  });
});

// `--limit abc` reached the search as NaN (and 0 / negatives as a zero or
// truncated slice) and printed "No matching tools or skills found." with exit 0.
test("test-search rejects a non-numeric or non-positive --limit with exit 1", async () => {
  await withTempConfig(async (dir, cfgPath) => {
    for (const limit of ["abc", "0", "-2", "2.5"]) {
      const res = runCli(["test-search", "hello", "--limit", limit, "--config", cfgPath], dir);
      assert.equal(res.status, 1, `--limit ${limit}: ${res.stdout}${res.stderr}`);
      assert.doesNotMatch(res.stdout, /No matching tools/);
      assert.match(res.stderr, /Invalid --limit "/);
    }
    const ok = runCli(["test-search", "hello", "--limit", "3", "--config", cfgPath], dir);
    assert.equal(ok.status, 0, ok.stderr);
  });
});
