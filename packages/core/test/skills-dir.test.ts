import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ActionHub } from "../dist/action-hub.js";
import { discoverSkillsFromDirectory } from "../dist/discovery/auto-discovery.js";
import type { SkillConfig } from "../dist/types.js";
import { testActionHub } from "./test-hub.ts";

test("a SKILL.md in a skills directory is discoverable, searchable, and loadable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skills-dir-"));
  const skillDir = join(dir, "deploy-runbook");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    [
      "---",
      'name: "Deploy Runbook"',
      "description: How to deploy safely.",
      "tags: [ops, deploy]",
      "---",
      "## Steps",
      "1. Run CI.",
      "2. Ship it.",
    ].join("\n"),
    "utf8",
  );

  const skills = await discoverSkillsFromDirectory(dir);
  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.id, "skill:deploy-runbook");
  assert.equal(skills[0]?.name, "Deploy Runbook");
  assert.equal(skills[0]?.trust, "trusted");

  // Same mapping createHubRuntime uses for migrated config skills.
  const hub = testActionHub({  clientFactory: async () => { throw new Error("not used"); } });
  hub.registerSkills(
    skills.map((s) => ({
      id: s.id,
      name: s.name,
      serverId: s.sourceClient ?? "skills",
      summary: s.summary,
      description: s.description,
      tags: s.tags,
      trust: s.trust ?? "trusted",
    })),
  );

  const hits = await hub.search("deploy runbook");
  assert.ok(hits.some((h) => h.id === "skill:deploy-runbook"));

  const loaded = hub.load("skill:deploy-runbook");
  assert.match(loaded.description ?? "", /Run CI/);

  // A missing directory simply yields no skills.
  assert.deepEqual(await discoverSkillsFromDirectory(join(dir, "nope")), []);
});

test("skills discovered from a directory carry the body as instructions on load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skills-dir-"));
  const skillPath = join(dir, "rotate-keys.md");
  await writeFile(
    skillPath,
    ["---", "name: Rotate Keys", "---", "", "Rotate via vault, then update configs."].join("\n"),
    "utf8",
  );

  const skills: SkillConfig[] = await discoverSkillsFromDirectory(dir);
  assert.equal(skills.length, 1);
  const hub = testActionHub({  clientFactory: async () => { throw new Error("not used"); } });
  hub.registerSkills(
    skills.map((s) => ({
      id: s.id,
      name: s.name,
      serverId: s.sourceClient ?? "skills",
      summary: s.summary,
      description: s.description,
      tags: s.tags,
      trust: s.trust ?? "trusted",
    })),
  );
  const loaded = hub.load(skills[0]!.id);
  assert.match(loaded.description ?? "", /Rotate via vault/);
});

test("colliding skill ids keep every skill: first keeps its id, later ones get a deterministic suffix", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skills-dir-"));
  for (const sub of ["a-dup", "b-dup", "c-dup"]) {
    const skillDir = join(dir, sub);
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      ["---", "name: Same Skill", "---", "", `Body of ${sub}.`].join("\n"),
      "utf8",
    );
  }
  // Two unreadable-skill fixtures, one per readFile branch. The EACCES one
  // (a loose .md with mode 0o000) only blocks reads when POSIX mode bits are
  // enforced: uid 0 reads it anyway and Windows ignores chmod, so it is only
  // created where it can fail. The EISDIR one (a skill directory whose SKILL.md
  // is itself a directory) is unreadable on every platform, including for root.
  const canLockFile = process.platform !== "win32" && process.getuid?.() !== 0;
  const locked = join(dir, "0-locked.md");
  if (canLockFile) {
    await writeFile(locked, "---\nname: Locked\n---\nsecret", "utf8");
    await chmod(locked, 0o000);
  }
  const notAFile = join(dir, "0-not-a-file", "SKILL.md");
  await mkdir(notAFile, { recursive: true });

  const warnings: string[] = [];
  const skills = await discoverSkillsFromDirectory(dir, "custom", (m) => warnings.push(m));

  // No silent loss: three same-named skills produce three distinct ids.
  const ids = skills.map((s) => s.id).sort();
  assert.deepEqual(ids, ["skill:same-skill", "skill:same-skill-2", "skill:same-skill-3"]);
  // The first (path-sorted) skill keeps the original id and content.
  assert.match(skills.find((s) => s.id === "skill:same-skill")?.description ?? "", /Body of a-dup/);
  assert.match(skills.find((s) => s.id === "skill:same-skill-2")?.description ?? "", /Body of b-dup/);
  assert.match(skills.find((s) => s.id === "skill:same-skill-3")?.description ?? "", /Body of c-dup/);
  // One warning per collision, naming both source paths.
  assert.ok(
    warnings.some((w) => w.includes('duplicate skill id "skill:same-skill"') && w.includes("a-dup") && w.includes("b-dup")),
  );
  assert.ok(
    warnings.some((w) => w.includes('duplicate skill id "skill:same-skill"') && w.includes("a-dup") && w.includes("c-dup")),
  );

  // An unreadable skill is skipped with a warning instead of aborting the scan.
  assert.ok(
    warnings.some((w) => w.includes("skipping unreadable skill") && w.includes(notAFile)),
    "EISDIR skill directory is skipped with a warning",
  );
  if (canLockFile) {
    assert.ok(
      warnings.some((w) => w.includes("skipping unreadable skill") && w.includes(locked)),
      "EACCES skill file is skipped with a warning",
    );
    await chmod(locked, 0o644).catch(() => undefined);
  }
});
