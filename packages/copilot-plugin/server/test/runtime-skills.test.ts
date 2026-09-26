import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHubRuntime } from "../dist/index.js";

async function writeSkill(dir: string, name: string, instructions: string): Promise<void> {
  const skillDir = join(dir, name.toLowerCase().replace(/\s+/g, "-"));
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    [`---`, `name: "${name}"`, `description: ${name} skill.`, `---`, ``, instructions].join("\n"),
    "utf8",
  );
}

test("createHubRuntime serves directory skills added after a warm cache was built", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "hub-runtime-"));
  const skillsDir = join(tmp, "skills");
  await mkdir(skillsDir, { recursive: true });
  const configPath = join(tmp, "config.json");
  const cachePath = join(tmp, "cache.json");
  await writeFile(configPath, JSON.stringify({ autoDiscover: false }), "utf8");

  const prevConfig = process.env["ACTION_HUB_CONFIG"];
  const prevCache = process.env["ACTION_HUB_CACHE"];
  const prevSkillsDir = process.env["ACTION_HUB_SKILLS_DIR"];
  process.env["ACTION_HUB_CONFIG"] = configPath;
  process.env["ACTION_HUB_CACHE"] = cachePath;
  process.env["ACTION_HUB_SKILLS_DIR"] = skillsDir;

  try {
    // Run 1: cold start with Alpha only; builds and warms the cache.
    await writeSkill(skillsDir, "Alpha Skill", "Step 1: alpha.");
    const run1 = await createHubRuntime({ control: false });
    await run1.refreshed;
    const hits1 = await run1.hub.search("alpha");
    assert.ok(hits1.some((h) => h.id === "skill:alpha-skill"));
    await run1.close();

    // Run 2: Beta is added after the cache was written. The warm cache must
    // not hide it: replaceSkills reconciles the always-live skill set.
    await writeSkill(skillsDir, "Beta Skill", "Step 1: beta.");
    const run2 = await createHubRuntime({ control: false });
    await run2.refreshed;
    const hits2 = await run2.hub.search("beta");
    assert.ok(hits2.some((h) => h.id === "skill:beta-skill"));
    const loaded = run2.hub.load("skill:beta-skill");
    assert.match(loaded.description ?? "", /Step 1: beta\./);
    const hits2Alpha = await run2.hub.search("alpha");
    assert.ok(hits2Alpha.some((h) => h.id === "skill:alpha-skill"));
    await run2.close();

    // Run 3: removal — deleting the Alpha directory drops it from the catalog.
    await rm(join(skillsDir, "alpha-skill"), { recursive: true, force: true });
    const run3 = await createHubRuntime({ control: false });
    await run3.refreshed;
    const hits3 = await run3.hub.search("alpha");
    assert.ok(!hits3.some((h) => h.id === "skill:alpha-skill"));
    assert.throws(() => run3.hub.load("skill:alpha-skill"), /Unknown action/);
    await run3.close();
  } finally {
    if (prevConfig === undefined) delete process.env["ACTION_HUB_CONFIG"];
    else process.env["ACTION_HUB_CONFIG"] = prevConfig;
    if (prevCache === undefined) delete process.env["ACTION_HUB_CACHE"];
    else process.env["ACTION_HUB_CACHE"] = prevCache;
    if (prevSkillsDir === undefined) delete process.env["ACTION_HUB_SKILLS_DIR"];
    else process.env["ACTION_HUB_SKILLS_DIR"] = prevSkillsDir;
    await rm(tmp, { recursive: true, force: true });
  }
});
