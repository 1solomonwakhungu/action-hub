/**
 * Fail-closed corpus loader shared by the search-quality eval scripts
 * (split-eval, latency-eval). Counts the ACTUAL manifests/tools/skills and
 * refuses anything but the default binding corpus (44 manifests / 10,000
 * tools / 5,000 skills) — a number that cannot fail is not evidence
 * (SQ2-R3 must-fix 3).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { FatalError } from "./harness.mjs";

export const BINDING_CORPUS = { manifests: 44, tools: 10_000, skills: 5_000 };

/** Loads and counts the generated corpus; FatalError unless binding counts. */
export function loadGeneratedCorpus(corpusDir) {
  const toolsDir = join(corpusDir, "tools");
  if (!statSync(toolsDir, { throwIfNoEntry: false })) {
    throw new FatalError(`corpus not found: ${toolsDir} (run node stress/gen-tools.mjs first)`);
  }
  const tools = [];
  for (const f of readdirSync(toolsDir)) {
    if (!f.endsWith(".json")) continue;
    const data = JSON.parse(readFileSync(join(toolsDir, f), "utf8"));
    const serverId = data.serverId ?? basename(f, ".json");
    for (const tool of data.tools ?? []) tools.push({ serverId, tool });
  }
  const skillsDir = join(corpusDir, "skills");
  if (!statSync(skillsDir, { throwIfNoEntry: false })) {
    throw new FatalError(`corpus not found: ${skillsDir} (run node stress/gen-skills.mjs first)`);
  }
  const skills = [];
  for (const entry of readdirSync(skillsDir)) {
    const p = join(skillsDir, entry);
    if (!statSync(p).isDirectory()) continue;
    const md = readFileSync(join(p, "SKILL.md"), "utf8");
    const name = md.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? entry;
    const desc = md.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
    const body = md.split(/^---$/m)[2]?.trim() ?? "";
    skills.push({ entry, name, desc, body });
  }
  const counts = {
    manifests: readdirSync(toolsDir).filter((f) => f.endsWith(".json")).length,
    tools: tools.length,
    skills: skills.length,
  };
  const mismatch = Object.entries(BINDING_CORPUS).filter(([k, v]) => counts[k] !== v);
  if (mismatch.length > 0) {
    throw new FatalError(
      `corpus does not match the binding counts (fail closed): got ${JSON.stringify(counts)}, ` +
        `expected ${JSON.stringify(BINDING_CORPUS)} — mismatched: ${mismatch.map(([k]) => k).join(", ")}`,
    );
  }
  return { tools, skills, counts };
}
