import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listCommand } from "../dist/commands/list.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const cliBin = resolve(testDir, "../dist/index.js");
const fixture = resolve(testDir, "fixtures/counting-mcp.mjs");

function captureConsole(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => void logs.push(args.join(" "));
  console.error = (...args: unknown[]) => void logs.push(args.join(" "));
  return {
    logs,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

// F10 regression: stdout to a pipe must not be truncated at 64 KiB. The bundle
// export is a single >1 MiB console.log write; with process.exit() pending
// writes used to be dropped at exactly 65,536 bytes.
test("CLI output over 64 KiB to a pipe is complete (F10)", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ah-pipe-"));
  const cfgPath = join(tempDir, "servers.json");
  const actionIds = Array.from({ length: 80_000 }, (_, i) => `srv:tool-${String(i).padStart(6, "0")}`);
  await writeFile(
    cfgPath,
    JSON.stringify({
      servers: [],
      bundles: [{ id: "big", displayName: "Big", description: "x", actionIds }],
      autoDiscover: false,
    }),
  );
  try {
    const res = spawnSync("node", [cliBin, "bundle", "--export", "big", "--config", cfgPath], {
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, HOME: tempDir },
    });
    assert.equal(res.status, 0, String(res.stderr));
    const out = res.stdout as Buffer;
    assert.ok(out.byteLength > 1_000_000, `expected >1MB, got ${out.byteLength}`);
    const parsed = JSON.parse(out.toString("utf8"));
    assert.equal(parsed.id, "big");
    assert.equal(parsed.actionIds.length, 80_000);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// F12 regression: list --server X must index only X, not the whole fleet.
test("list --server indexes only the requested server (F12)", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ah-list-srv-"));
  const countA = join(tempDir, "count-a");
  const countB = join(tempDir, "count-b");
  const cfgPath = join(tempDir, "servers.json");
  await writeFile(
    cfgPath,
    JSON.stringify({
      servers: [
        {
          id: "srv-a",
          transport: { type: "stdio", command: process.execPath, args: [fixture], env: { COUNT_FILE: countA } },
        },
        {
          id: "srv-b",
          transport: { type: "stdio", command: process.execPath, args: [fixture], env: { COUNT_FILE: countB } },
        },
      ],
      autoDiscover: false,
    }),
  );

  try {
    const captured = captureConsole();
    try {
      const code = await listCommand({ configPath: cfgPath, server: "srv-a" });
      assert.equal(code, 0);
    } finally {
      captured.restore();
    }
    const spawnsA = (await readFile(countA, "utf8")).trim().split("\n").filter(Boolean);
    assert.equal(spawnsA.length, 1, `srv-a spawned once, got ${spawnsA.length}`);
    // srv-b must never have been contacted.
    let contacted = false;
    try {
      await readFile(countB, "utf8");
      contacted = true;
    } catch {
      contacted = false;
    }
    assert.equal(contacted, false, "srv-b must not be indexed by list --server srv-a");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// F11 regression: list --kind skill must include config.skills entries and the
// skills directory, exactly like the runtime registers them.
test("list --kind skill registers config and directory skills (F11)", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ah-list-skill-"));
  const cfgPath = join(tempDir, "servers.json");
  const skillsDir = join(tempDir, "skills");
  await mkdir(join(skillsDir, "dir-skill"), { recursive: true });
  await writeFile(
    join(skillsDir, "dir-skill", "SKILL.md"),
    "---\nname: Dir Skill\ndescription: A skill from the skills directory\n---\nBody\n",
  );
  await writeFile(
    cfgPath,
    JSON.stringify({
      servers: [],
      skills: [
        {
          id: "config-skill",
          name: "Config Skill",
          summary: "A skill from config",
          description: "config",
        },
      ],
      autoDiscover: false,
    }),
  );

  try {
    const previousSkillsDir = process.env["ACTION_HUB_SKILLS_DIR"];
    process.env["ACTION_HUB_SKILLS_DIR"] = skillsDir;
    const captured = captureConsole();
    try {
      const code = await listCommand({ configPath: cfgPath, kind: "skill" });
      assert.equal(code, 0);
      const output = captured.logs.join("\n");
      assert.match(output, /Config Skill/);
      assert.match(output, /Dir Skill/);
      assert.equal(code, 0);
    } finally {
      captured.restore();
      if (previousSkillsDir === undefined) delete process.env["ACTION_HUB_SKILLS_DIR"];
      else process.env["ACTION_HUB_SKILLS_DIR"] = previousSkillsDir;
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
