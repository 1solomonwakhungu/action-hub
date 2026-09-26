import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ActionHub } from "../dist/action-hub.js";
import { discoverSkillsFromDirectory } from "../dist/discovery/auto-discovery.js";
import type { SkillConfig } from "../dist/types.js";

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
  const hub = new ActionHub({ clientFactory: async () => { throw new Error("not used"); } });
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
  const hub = new ActionHub({ clientFactory: async () => { throw new Error("not used"); } });
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
  const locked = join(dir, "0-locked.md");
  await writeFile(locked, "---\nname: Locked\n---\nsecret", "utf8");
  let chmodOk = false;
  try {
    await chmod(locked, 0o000);
    chmodOk = true;
  } catch {
    // e.g. running as root: the file stays readable, no EACCES to simulate.
  }

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

  // An unreadable file is skipped with a warning instead of aborting the scan.
  if (chmodOk) {
    assert.ok(warnings.some((w) => w.includes("0-locked.md")));
  }
  await chmod(locked, 0o644).catch(() => undefined);
});
