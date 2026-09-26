import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SkillStore, parseSkillFile } from "../dist/skills/skill-store.js";

test("parses a SKILL.md and the store registers, searches, and converts to action records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-store-"));
  const skillDir = join(dir, "incident-triage");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    [
      "---",
      'name: "Incident Triage"',
      "description: Triage a production incident.",
      "user-invocable: false",
      "tags:",
      "  - ops",
      "  - incident",
      "---",
      "## Steps",
      "1. Confirm impact.",
      "2. Page the owner.",
    ].join("\n"),
    "utf8",
  );

  const store = new SkillStore();
  const added = await store.registerDirectory(dir);
  assert.equal(added.length, 1);

  const skill = store.get("skill:incident-triage");
  assert.ok(skill);
  assert.equal(skill?.name, "Incident Triage");
  assert.equal(skill?.description, "Triage a production incident.");
  assert.equal(skill?.userInvocable, false);
  assert.deepEqual(skill?.tags, ["ops", "incident"]);
  assert.match(skill?.instructions ?? "", /Confirm impact/);

  assert.equal(store.search("incident ops").length, 1);
  assert.equal(store.search("nonexistent").length, 0);

  const records = store.toActionRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.id, "skill:incident-triage");
  assert.equal(records[0]?.kind, "skill");

  // parseSkillFile works standalone and derives the name from the directory
  // when frontmatter omits one.
  const minimal = join(dir, "bare");
  await mkdir(minimal, { recursive: true });
  await writeFile(join(minimal, "SKILL.md"), "Just the instructions.", "utf8");
  const parsed = await parseSkillFile(join(minimal, "SKILL.md"));
  assert.equal(parsed.name, "bare");
  assert.equal(parsed.userInvocable, true);
});
