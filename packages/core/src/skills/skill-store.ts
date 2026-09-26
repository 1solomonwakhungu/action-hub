import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { ActionRecord, TrustTier } from "../types.js";

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  instructions: string;
  summary: string;
  tags?: string[];
  userInvocable?: boolean;
  path?: string;
  trust?: TrustTier;
}

export async function parseSkillFile(filePath: string): Promise<SkillDefinition> {
  const content = await readFile(filePath, "utf8");
  const trimmed = content.trim();
  let name = "";
  let summary = "";
  let description = "";
  let instructions = trimmed;
  let userInvocable = true;
  const tags: string[] = [];

  if (trimmed.startsWith("---")) {
    const secondDelim = trimmed.indexOf("\n---", 3);
    if (secondDelim !== -1) {
      const frontmatter = trimmed.slice(3, secondDelim).trim();
      instructions = trimmed.slice(secondDelim + 4).trim();

      for (const rawLine of frontmatter.split("\n")) {
        const line = rawLine.trim();
        if (line.startsWith("name:")) {
          name = line.slice(5).trim().replace(/^["\x27]|["\x27]$/g, "");
        } else if (line.startsWith("description:")) {
          description = line.slice(12).trim().replace(/^["\x27]|["\x27]$/g, "");
        } else if (line.startsWith("user-invocable:") || line.startsWith("userInvocable:")) {
          userInvocable = line.split(":")[1]?.trim() !== "false";
        } else if (line.startsWith("tags:")) {
          const val = line.slice(5).trim();
          if (val.startsWith("[") && val.endsWith("]")) {
            tags.push(
              ...val
                .slice(1, -1)
                .split(",")
                .map((t) => t.trim().replace(/^["\x27]|["\x27]$/g, ""))
                .filter(Boolean),
            );
          }
        } else if (line.startsWith("- ")) {
          tags.push(line.slice(2).trim().replace(/^["\x27]|["\x27]$/g, ""));
        }
      }
    }
  }

  if (!name) {
    const base = basename(filePath, extname(filePath));
    name = base === "SKILL" ? basename(dirname(filePath)) : base;
  }
  if (!summary) {
    summary = description || name;
  }

  const normalizedId = `skill:${name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`;

  return {
    id: normalizedId,
    name,
    description: description || summary,
    summary,
    instructions,
    tags: tags.length > 0 ? tags : undefined,
    userInvocable,
    path: filePath,
    trust: "trusted",
  };
}

export class SkillStore {
  readonly #skills = new Map<string, SkillDefinition>();

  register(skill: SkillDefinition): void {
    this.#skills.set(skill.id, skill);
  }

  async registerDirectory(dirPath: string): Promise<SkillDefinition[]> {
    const added: SkillDefinition[] = [];
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".mdc"))) {
        const skill = await parseSkillFile(fullPath);
        this.register(skill);
        added.push(skill);
      } else if (entry.isDirectory()) {
        const skillMd = join(fullPath, "SKILL.md");
        try {
          const st = await stat(skillMd);
          if (st.isFile()) {
            const skill = await parseSkillFile(skillMd);
            this.register(skill);
            added.push(skill);
          }
        } catch {
          // ignore
        }
      }
    }
    return added;
  }

  get(id: string): SkillDefinition | undefined {
    return this.#skills.get(id);
  }

  list(): SkillDefinition[] {
    return [...this.#skills.values()];
  }

  search(query: string): SkillDefinition[] {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return this.list();
    return this.list().filter((s) => {
      const text = `${s.id} ${s.name} ${s.summary} ${s.description} ${(s.tags ?? []).join(" ")}`.toLowerCase();
      return terms.every((t) => text.includes(t));
    });
  }

  toActionRecords(): ActionRecord[] {
    return this.list().map((s) => ({
      id: s.id,
      kind: "skill" as const,
      serverId: "skills",
      name: s.name,
      summary: s.summary,
      description: s.instructions,
      tags: s.tags,
      trust: s.trust ?? "trusted",
    }));
  }
}
