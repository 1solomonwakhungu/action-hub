import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CatalogCache, type PersistedCatalog } from "@action-hub/core";
import { createHubRuntime } from "../dist/index.js";

// F69 rework (reviewer-2): deterministic write scheduling. The injected
// cache delays BEFORE the real write, so the write is genuinely in flight
// at close() time ("never" = never settles at all, for the timeout branch).
class DelayedWriteCache extends CatalogCache {
  readonly #delayMs: number | "never";
  #writes = 0;
  constructor(path: string, delayMs: number | "never") {
    super({ path });
    this.#delayMs = delayMs;
  }
  override write(entry: PersistedCatalog): Promise<boolean> {
    this.#writes += 1;
    // Only the SECOND write (the post-embedding vector re-persist) is
    // deferred/blocked — blocking the first would hang the refresh itself.
    if (this.#delayMs === "never" && this.#writes >= 2) {
      return new Promise<boolean>(() => undefined);
    }
    if (this.#delayMs === "never" || this.#writes < 2) return super.write(entry);
    return new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(super.write(entry)), this.#delayMs);
    });
  }
}

// F69 rework: the REAL warning classes a broken drain produces (word order
// and the pid/uuid temp filename matter — see the red/green note).
const CACHE_WARNING = /(could not write catalog cache)|(post-embedding cache write)|(did not settle)|(cache\.json\.[^\s]*\.tmp)/;

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

  // Deterministic drain: the injected cache holds its SECOND write (the
  // vector re-persist) in flight for 150ms, so a close() that does not
  // drain deterministically leaves it pending past the temp-dir removal.
  const delayed = new DelayedWriteCache(cachePath, 150);

  const collected: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    collected.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    // Run 1: cold start with Alpha only; builds and warms the cache.
    await writeSkill(skillsDir, "Alpha Skill", "Step 1: alpha.");
    const run1 = await createHubRuntime({ embeddings: null, cache: delayed })
    await run1.startRefresh();
    const hits1 = await run1.hub.search("alpha");
    assert.ok(hits1.some((h) => h.id === "skill:alpha-skill"));
    await run1.close();

    // Run 2: Beta is added after the cache was written. The warm cache must
    // not hide it: replaceSkills reconciles the always-live skill set.
    await writeSkill(skillsDir, "Beta Skill", "Step 1: beta.");
    const run2 = await createHubRuntime({ embeddings: null, cache: delayed })
    await run2.startRefresh();
    const hits2 = await run2.hub.search("beta");
    assert.ok(hits2.some((h) => h.id === "skill:beta-skill"));
    const loaded = run2.hub.load("skill:beta-skill");
    assert.match(loaded.description ?? "", /Step 1: beta\./);
    const hits2Alpha = await run2.hub.search("alpha");
    assert.ok(hits2Alpha.some((h) => h.id === "skill:alpha-skill"));
    await run2.close();

    // Run 3: removal — deleting the Alpha directory drops it from the catalog.
    await rm(join(skillsDir, "alpha-skill"), { recursive: true, force: true });
    const run3 = await createHubRuntime({ embeddings: null, cache: delayed })
    await run3.startRefresh();
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
    process.stderr.write = originalWrite;
    // F69: close() now DRAINS the post-embedding cache write (bounded), so
    // the temp directory can be removed immediately — no retry, and no
    // post-close cache warning may have been emitted either.
    await rm(tmp, { recursive: true, force: true });
    assert.equal(
      collected.some((line) => CACHE_WARNING.test(line)),
      false,
      `post-close cache warning leaked: ${collected.filter((l) => l.includes("cache")).join(" | ")}`,
    );
  }
});

test("F69: close drains the in-flight embedding rebuild's vector write (immediate temp removal, no warning)", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "hub-runtime-f69-"));
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

  // Deterministic drain: the injected cache holds its SECOND write (the
  // vector re-persist) in flight for 150ms, so a close() that does not
  // drain deterministically leaves it pending past the temp-dir removal.
  const delayed = new DelayedWriteCache(cachePath, 150);

  const collected: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    collected.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    // Default embeddings: an in-flight WASM rebuild is live when close()
    // runs. close() must cancel/settle the rebuild AND drain the vector
    // write, so the immediate temp-dir removal succeeds with no leak.
    await writeSkill(skillsDir, "Gamma Skill", "Step 1: gamma.");
    const run = await createHubRuntime();
    await run.startRefresh();
    await run.close();
  } finally {
    process.stderr.write = originalWrite;
    if (prevConfig === undefined) delete process.env["ACTION_HUB_CONFIG"];
    else process.env["ACTION_HUB_CONFIG"] = prevConfig;
    if (prevCache === undefined) delete process.env["ACTION_HUB_CACHE"];
    else process.env["ACTION_HUB_CACHE"] = prevCache;
    if (prevSkillsDir === undefined) delete process.env["ACTION_HUB_SKILLS_DIR"];
    else process.env["ACTION_HUB_SKILLS_DIR"] = prevSkillsDir;
    await rm(tmp, { recursive: true, force: true });
    assert.equal(
      collected.some((line) => CACHE_WARNING.test(line)),
      false,
      `close-time cache warning leaked: ${collected.filter((l) => l.includes("cache")).join(" | ")}`,
    );
  }
});

test("F69 rework: a blocked vector write makes close() warn and return within the 2s bound", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "hub-runtime-f69-blocked-"));
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

  const collected: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    collected.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    await writeSkill(skillsDir, "Delta Skill", "Step 1: delta.");
    const run = await createHubRuntime({
      embeddings: null,
      cache: new DelayedWriteCache(cachePath, "never"),
    });
    await run.startRefresh();
    // The second (vector) write never settles: close() must hit the 2s
    // bound, emit the non-settlement warning (surfaced, not swallowed), and
    // RETURN — proving the losing timer is cleared (a dangling handle would
    // keep the event loop alive past this point).
    const t0 = Date.now();
    await run.close();
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 4_000, `close() took ${elapsed}ms — the 2s bound did not return`);
    assert.ok(
      collected.some((line) => line.includes("did not settle within 2s")),
      `non-settlement warning missing: ${collected.filter((l) => l.includes("cache")).join(" | ")}`,
    );
  } finally {
    process.stderr.write = originalWrite;
    if (prevConfig === undefined) delete process.env["ACTION_HUB_CONFIG"];
    else process.env["ACTION_HUB_CONFIG"] = prevConfig;
    if (prevCache === undefined) delete process.env["ACTION_HUB_CACHE"];
    else process.env["ACTION_HUB_CACHE"] = prevCache;
    if (prevSkillsDir === undefined) delete process.env["ACTION_HUB_SKILLS_DIR"];
    else process.env["ACTION_HUB_SKILLS_DIR"] = prevSkillsDir;
    await rm(tmp, { recursive: true, force: true });
  }
});
