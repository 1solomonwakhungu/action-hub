import { readFile, readdir, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import type {
  DiscoveredPlugin,
  DiscoveredServer,
  DiscoveredSkill,
  ServerConfig,
  SkillConfig,
} from "../types.js";

export { type DiscoveredServer, type DiscoveredSkill, type DiscoveredPlugin };

export type CustomDiscoveryPath = string | { path: string; client: DiscoveredServer["sourceClient"] };

export interface DiscoveryOptions {
  cwd?: string;
  home?: string;
  customPaths?: CustomDiscoveryPath[];
  skipDefaults?: boolean;
}

/** Standard locations where popular AI and developer tools save MCP configurations. */
export function defaultDiscoveryLocations(
  options: DiscoveryOptions = {},
): { path: string; client: DiscoveredServer["sourceClient"] }[] {
  const locations: { path: string; client: DiscoveredServer["sourceClient"] }[] = [];

  if (options.customPaths) {
    for (const custom of options.customPaths) {
      locations.push(
        typeof custom === "string"
          ? { path: custom, client: "custom" }
          : { path: custom.path, client: custom.client },
      );
    }
  }

  if (options.skipDefaults) {
    return locations;
  }

  const home = options.home ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const os = platform();

  // Claude Desktop config
  if (os === "darwin") {
    locations.push({
      path: resolve(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
      client: "claude-desktop",
    });
  } else if (os === "win32") {
    const appData = process.env["APPDATA"] ?? resolve(home, "AppData", "Roaming");
    locations.push({
      path: resolve(appData, "Claude", "claude_desktop_config.json"),
      client: "claude-desktop",
    });
  } else {
    locations.push({
      path: resolve(home, ".config", "Claude", "claude_desktop_config.json"),
      client: "claude-desktop",
    });
  }

  // Cursor MCP configs
  locations.push(
    { path: resolve(home, ".cursor", "mcp.json"), client: "cursor" },
    { path: resolve(cwd, ".cursor", "mcp.json"), client: "cursor" },
  );

  // VS Code MCP configs
  locations.push(
    { path: resolve(home, ".vscode", "mcp.json"), client: "vscode" },
    { path: resolve(cwd, ".vscode", "mcp.json"), client: "vscode" },
  );

  // Copilot MCP configs
  locations.push(
    { path: resolve(home, ".copilot", "mcp.json"), client: "copilot" },
    { path: resolve(cwd, ".mcp.json"), client: "copilot" },
  );

  // Codex MCP config (TOML)
  locations.push({
    path: resolve(home, ".codex", "config.toml"),
    client: "codex",
  });

  // Windsurf MCP config
  locations.push(
    { path: resolve(home, ".codeium", "windsurf", "mcp_config.json"), client: "windsurf" },
    { path: resolve(cwd, ".windsurf", "mcp.json"), client: "windsurf" },
  );

  // VS Code global storage based harness configs (Cline / Roo Code)
  const globalStorageRoot =
    os === "darwin"
      ? resolve(home, "Library", "Application Support", "Code", "User", "globalStorage")
      : os === "win32"
        ? resolve(process.env["APPDATA"] ?? resolve(home, "AppData", "Roaming"), "Code", "User", "globalStorage")
        : resolve(home, ".config", "Code", "User", "globalStorage");

  locations.push(
    {
      path: resolve(globalStorageRoot, "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
      client: "cline",
    },
    {
      path: resolve(globalStorageRoot, "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json"),
      client: "roo-code",
    },
    { path: resolve(home, ".roo", "mcp.json"), client: "roo-code" },
  );

  return locations;
}

/**
 * Scans known client configurations and imports standard MCP server definitions.
 */
export async function discoverMcpServers(options: DiscoveryOptions = {}): Promise<DiscoveredServer[]> {
  const locations = defaultDiscoveryLocations(options);
  const discovered: DiscoveredServer[] = [];
  const seenIds = new Set<string>();

  for (const { path, client } of locations) {
    try {
      const content = await readFile(path, "utf8");
      const parsed = extname(path) === ".toml" ? parseTomlMcpServers(content) : (JSON.parse(content) as Record<string, unknown>);
      const servers = parseMcpServersBlock(parsed, path, client);

      for (const server of servers) {
        if (!seenIds.has(server.id)) {
          seenIds.add(server.id);
          discovered.push(server);
        }
      }
    } catch {
      // Missing or unreadable files are silently skipped during auto-discovery
    }
  }

  return discovered;
}

/**
 * Minimal zero-dependency TOML parser for Codex `~/.codex/config.toml` MCP blocks.
 * Extracts `[mcp_servers.<name>]` sections (plus nested `env`, `headers`, and
 * `http_headers` subtables) into an `mcpServers` dictionary shaped like the JSON
 * format, so the standard server normalization can consume it. Supports string,
 * array-of-strings, boolean, number, and inline-table values, inline comments,
 * and multiline arrays. Unknown sections and keys are ignored.
 */
export function parseTomlMcpServers(content: string): Record<string, unknown> {
  const servers: Record<string, Record<string, unknown>> = {};
  let currentServer: string | undefined;
  let currentSubtable: Record<string, unknown> | undefined;

  const lines = stripTomlComments(content).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]?.trim() ?? "";
    if (line.length === 0) continue;

    const sectionMatch = line.match(/^\[+\s*([^\]]+?)\s*\]+$/);
    if (sectionMatch) {
      const section = parseTomlSectionPath(sectionMatch[1] ?? "");
      currentServer = section?.name;
      currentSubtable = section?.subtable;
      if (currentServer) {
        servers[currentServer] ??= {};
        const server = servers[currentServer]!;
        if (currentSubtable && section) {
          const existing = server[section.key];
          if (existing && typeof existing === "object" && !Array.isArray(existing)) {
            // Keep pre-existing inline table (e.g. env = { ... }) and merge into it.
            currentSubtable = existing as Record<string, unknown>;
          } else {
            server[section.key] = currentSubtable;
          }
        }
      }
      continue;
    }

    if (!currentServer) continue;

    // Multiline array: buffer lines until the closing bracket is found.
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^"|"$/g, "");
    let rawValue = line.slice(eq + 1).trim();
    if (rawValue.startsWith("[") && !rawValue.endsWith("]")) {
      const buffer: string[] = [rawValue];
      while (i + 1 < lines.length && !rawValue.endsWith("]")) {
        i++;
        rawValue = lines[i]?.trim() ?? "";
        buffer.push(rawValue);
      }
      rawValue = buffer.join(" ");
    }

    const value = parseTomlValue(rawValue);
    if (key && value !== undefined) {
      if (currentSubtable) {
        currentSubtable[key] = value;
      } else {
        servers[currentServer]![key] = value;
      }
    }
  }

  return { mcpServers: servers };
}

/** Strips `#` comments to end of line, respecting quoted strings. */
function stripTomlComments(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => {
      let inString: string | undefined;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inString) {
          if (ch === inString) inString = undefined;
          continue;
        }
        if (ch === '"' || ch === "'") {
          inString = ch;
          continue;
        }
        if (ch === "#") return line.slice(0, i).trimEnd();
      }
      return line;
    })
    .join("\n");
}

function parseTomlSectionPath(
  raw: string,
): { name: string; key: string; subtable?: Record<string, unknown> } | undefined {
  // Supported: mcp_servers.<name>, mcp_servers.<name>.env,
  // mcp_servers.<name>.headers, mcp_servers.<name>.http_headers
  const match = raw.match(
    /^mcp_servers\.\s*"?([^".]+)"?\s*(?:\.\s*(env|headers|http_headers))?$/,
  );
  if (!match) return undefined;
  const name = match[1]?.trim();
  if (!name) return undefined;
  const key = match[2];
  if (key === "env") {
    return { name, key: "env", subtable: {} };
  }
  if (key === "headers" || key === "http_headers") {
    return { name, key: "headers", subtable: {} };
  }
  return { name, key: "__server__" };
}

function parseTomlValue(raw: string): unknown {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw.slice(1, -1);
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return raw.slice(1, -1);
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw.startsWith("[")) {
    const inner = raw.replace(/^\[|\]$/g, "");
    return splitTomlCommaList(inner)
      .map((item) => {
        if ((item.startsWith('"') && item.endsWith('"')) || (item.startsWith("'") && item.endsWith("'"))) {
          return item.slice(1, -1);
        }
        return item;
      });
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith("{")) {
    // Inline table: { KEY = "value", ... }
    const inner = raw.replace(/^\{|\}$/g, "");
    const result: Record<string, unknown> = {};
    for (const pair of splitTomlCommaList(inner)) {
      const pairEq = pair.indexOf("=");
      if (pairEq === -1) continue;
      const pairKey = pair.slice(0, pairEq).trim().replace(/^"|"$/g, "");
      const pairValue = parseTomlValue(pair.slice(pairEq + 1).trim());
      if (pairKey && pairValue !== undefined) result[pairKey] = pairValue;
    }
    return result;
  }
  return undefined;
}

/** Splits a comma-separated TOML element list on commas outside quoted strings. */
function splitTomlCommaList(inner: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inString: string | undefined;
  for (const ch of inner) {
    if (inString) {
      current += ch;
      if (ch === inString) inString = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      current += ch;
      continue;
    }
    if (ch === ",") {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) parts.push(current.trim());
  return parts.filter((p) => p.length > 0);
}

function parseMcpServersBlock(
  doc: Record<string, unknown>,
  sourcePath: string,
  sourceClient: DiscoveredServer["sourceClient"],
): DiscoveredServer[] {
  const results: DiscoveredServer[] = [];
  const serversBlock = doc["mcpServers"] ?? doc["servers"];

  if (typeof serversBlock !== "object" || serversBlock === null) {
    return results;
  }

  if (Array.isArray(serversBlock)) {
    // Array format: [ { id, command, args, url, ... } ]
    for (const entry of serversBlock) {
      if (typeof entry === "object" && entry !== null && typeof entry["id"] === "string") {
        const parsed = normalizeServerEntry(entry["id"], entry as Record<string, unknown>, sourcePath, sourceClient);
        if (parsed) results.push(parsed);
      }
    }
  } else {
    // Object dictionary format: { "serverName": { command, args, url, ... } }
    for (const [id, entry] of Object.entries(serversBlock)) {
      if (typeof entry === "object" && entry !== null) {
        const parsed = normalizeServerEntry(id, entry as Record<string, unknown>, sourcePath, sourceClient);
        if (parsed) results.push(parsed);
      }
    }
  }

  return results;
}

function normalizeServerEntry(
  id: string,
  raw: Record<string, unknown>,
  sourcePath: string,
  sourceClient: DiscoveredServer["sourceClient"],
): DiscoveredServer | undefined {
  if (typeof raw["url"] === "string" && raw["url"].length > 0) {
    const headers =
      typeof raw["headers"] === "object" && raw["headers"] !== null
        ? Object.fromEntries(
            Object.entries(raw["headers"] as Record<string, unknown>)
              .filter(([, v]) => typeof v === "string")
              .map(([k, v]) => [k, String(v)]),
          )
        : undefined;

    return {
      id,
      displayName: typeof raw["displayName"] === "string" ? raw["displayName"] : id,
      transport: {
        type: "http",
        url: raw["url"],
        headers,
      },
      trust: "untrusted",
      enabled: raw["enabled"] !== false,
      sourcePath,
      sourceClient,
    };
  }

  if (typeof raw["command"] === "string" && raw["command"].length > 0) {
    const args = Array.isArray(raw["args"])
      ? raw["args"].filter((a): a is string => typeof a === "string")
      : [];

    const env =
      typeof raw["env"] === "object" && raw["env"] !== null
        ? Object.fromEntries(
            Object.entries(raw["env"] as Record<string, unknown>)
              .filter(([, v]) => typeof v === "string")
              .map(([k, v]) => [k, String(v)]),
          )
        : undefined;

    return {
      id,
      displayName: typeof raw["displayName"] === "string" ? raw["displayName"] : id,
      transport: {
        type: "stdio",
        command: raw["command"],
        args,
        env,
        cwd: typeof raw["cwd"] === "string" ? raw["cwd"] : undefined,
      },
      trust: "untrusted",
      enabled: raw["enabled"] !== false,
      sourcePath,
      sourceClient,
    };
  }

  return undefined;
}

/**
 * Standard locations to search for skill files and directories.
 */
export function defaultSkillDiscoveryLocations(
  options: DiscoveryOptions = {},
): { dir: string; client: DiscoveredSkill["sourceClient"] }[] {
  const dirs: { dir: string; client: DiscoveredSkill["sourceClient"] }[] = [];

  if (options.customPaths) {
    for (const custom of options.customPaths) {
      dirs.push({ dir: typeof custom === "string" ? custom : custom.path, client: "custom" });
    }
  }

  if (options.skipDefaults) {
    return dirs;
  }

  const home = options.home ?? homedir();
  const cwd = options.cwd ?? process.cwd();

  // Copilot skills
  dirs.push(
    { dir: resolve(cwd, ".github", "skills"), client: "copilot" },
    { dir: resolve(cwd, ".copilot", "skills"), client: "copilot" },
    { dir: resolve(cwd, "skills"), client: "copilot" },
    { dir: resolve(home, ".copilot", "skills"), client: "copilot" },
  );

  // Claude & Agent skills
  dirs.push(
    { dir: resolve(cwd, ".claude", "skills"), client: "claude" },
    { dir: resolve(cwd, ".agents", "skills"), client: "agents" },
    { dir: resolve(cwd, ".gemini", "skills"), client: "agents" },
    { dir: resolve(home, ".agents", "skills"), client: "agents" },
  );

  // Cursor rules directory
  dirs.push({ dir: resolve(cwd, ".cursor", "rules"), client: "cursor" });

  return dirs;
}

/**
 * Parses markdown skill content and extracts YAML frontmatter, summary, and instructions.
 */
export function parseSkillContent(
  rawContent: string,
  filePath: string,
  sourceClient: DiscoveredSkill["sourceClient"],
): DiscoveredSkill {
  const trimmed = rawContent.trim();
  let name = "";
  let summary = "";
  let description = trimmed;
  const tags: string[] = [];

  // Parse YAML-like frontmatter if present: --- ... ---
  if (trimmed.startsWith("---")) {
    const secondDelim = trimmed.indexOf("\n---", 3);
    if (secondDelim !== -1) {
      const frontmatter = trimmed.slice(3, secondDelim).trim();
      description = trimmed.slice(secondDelim + 4).trim();

      const lines = frontmatter.split("\n");
      let currentKey = "";
      let inMultiline = false;
      let multilineVal = "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (inMultiline) {
          if (line.startsWith("- ") || line.includes(":")) {
            inMultiline = false;
            if (currentKey === "description") summary = multilineVal.trim();
          } else {
            multilineVal += " " + line;
            continue;
          }
        }

        if (line.startsWith("name:")) {
          name = line.slice(5).trim().replace(/^["']|["']$/g, "");
          currentKey = "name";
        } else if (line.startsWith("description:")) {
          const val = line.slice(12).trim().replace(/^["']|["']$/g, "");
          if (val === ">-" || val === "|" || val === ">") {
            inMultiline = true;
            multilineVal = "";
          } else {
            summary = val;
          }
          currentKey = "description";
        } else if (line.startsWith("- ") && currentKey === "tags") {
          const tag = line.slice(2).trim().replace(/^["']|["']$/g, "");
          if (tag) tags.push(tag);
        } else if (line.startsWith("tags:")) {
          currentKey = "tags";
          const inlineTags = line.slice(5).trim();
          if (inlineTags.startsWith("[") && inlineTags.endsWith("]")) {
            const parsed = inlineTags
              .slice(1, -1)
              .split(",")
              .map((t) => t.trim().replace(/^["']|["']$/g, ""))
              .filter(Boolean);
            tags.push(...parsed);
          }
        }
      }

      if (inMultiline && currentKey === "description") {
        summary = multilineVal.trim();
      }
    }
  }

  // Fallback defaults if frontmatter is absent or sparse
  if (!name) {
    const headerMatch = description.match(/^#+\s+(.+)$/m);
    if (headerMatch && headerMatch[1]) {
      name = headerMatch[1].trim();
    } else {
      const base = basename(filePath, extname(filePath));
      name = base === "SKILL" ? basename(dirname(filePath)) : base;
    }
  }

  if (!summary) {
    const firstPara = description
      .split("\n\n")
      .map((p) => p.trim())
      .find((p) => p.length > 0 && !p.startsWith("#"));
    summary = firstPara ? firstPara.slice(0, 160).replace(/\n/g, " ") : name;
  }

  const normalizedId = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return {
    id: `skill:${normalizedId}`,
    name,
    summary,
    description,
    tags: tags.length > 0 ? tags : undefined,
    trust: "trusted",
    sourcePath: filePath,
    sourceClient,
  };
}

/**
 * Scans directories for skills (.md, .mdc, SKILL.md, .cursorrules).
 */
export async function discoverSkills(options: DiscoveryOptions = {}): Promise<DiscoveredSkill[]> {
  const discovered: DiscoveredSkill[] = [];
  const seenIds = new Map<string, string>();

  // Check direct .cursorrules in cwd
  if (!options.skipDefaults) {
    const cwd = options.cwd ?? process.cwd();
    const cursorRulesPath = resolve(cwd, ".cursorrules");
    try {
      const content = await readFile(cursorRulesPath, "utf8");
      const skill = parseSkillContent(content, cursorRulesPath, "cursor");
      skill.id = "skill:cursorrules";
      skill.name = "Cursor Rules";
      discovered.push(skill);
      seenIds.set(skill.id, cursorRulesPath);
    } catch {
      // Missing .cursorrules is normal
    }
  }

  const locations = defaultSkillDiscoveryLocations(options);

  for (const { dir, client } of locations) {
    try {
      const st = await stat(dir);
      if (!st.isDirectory()) {
        if (st.isFile()) {
          const content = await readFile(dir, "utf8");
          const skill = parseSkillContent(content, dir, client);
          if (!seenIds.has(skill.id)) {
            seenIds.set(skill.id, dir);
            discovered.push(skill);
          }
        }
        continue;
      }

  await scanSkillDirectory(dir, client, seenIds, discovered);
    } catch {
      // Directory missing or unreadable
    }
  }

  return discovered;
}

/**
 * Scans a single directory for skills: a `SKILL.md` inside each
 * subdirectory, plus top-level `.md`/`.mdc` files. Uses the canonical
 * `parseSkillContent` parser. A missing or unreadable directory simply
 * yields no skills.
 */
export async function discoverSkillsFromDirectory(
  dirPath: string,
  sourceClient: DiscoveredSkill["sourceClient"] = "custom",
  onWarning: (message: string) => void = (message) =>
    process.stderr.write(`action-hub: ${message}\n`),
): Promise<DiscoveredSkill[]> {
  const discovered: DiscoveredSkill[] = [];
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    if (entries.length === 0) return discovered;
  } catch {
    // Directory missing or unreadable: no skills.
    return discovered;
  }
  await scanSkillDirectory(dirPath, sourceClient, new Map(), discovered, onWarning);
  return discovered;
}

function describeFailure(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Shared directory scanner used by `discoverSkills` and `discoverSkillsFromDirectory`. */
async function scanSkillDirectory(
  dir: string,
  client: DiscoveredSkill["sourceClient"],
  seenIds: Map<string, string>,
  discovered: DiscoveredSkill[],
  onWarning?: (message: string) => void,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  // Deterministic winner for duplicate ids: first entry by name wins.
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of sorted) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Look for SKILL.md inside skill subdirectory
      const skillMdPath = join(fullPath, "SKILL.md");
      let content: string;
      try {
        content = await readFile(skillMdPath, "utf8");
      } catch (cause) {
        // A single unreadable skill must never abort discovery.
        onWarning?.(
          `skipping unreadable skill "${skillMdPath}": ${describeFailure(cause)}`,
        );
        continue;
      }
      const skill = parseSkillContent(content, skillMdPath, client);
      const previous = seenIds.get(skill.id);
      if (previous) {
        onWarning?.(
          `duplicate skill id "${skill.id}": "${previous}" wins over "${skillMdPath}"`,
        );
        continue;
      }
      seenIds.set(skill.id, skillMdPath);
      discovered.push(skill);
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      if (ext === ".md" || ext === ".mdc") {
        let content: string;
        try {
          content = await readFile(fullPath, "utf8");
        } catch (cause) {
          // A single unreadable skill must never abort discovery.
          onWarning?.(`skipping unreadable skill "${fullPath}": ${describeFailure(cause)}`);
          continue;
        }
        const skill = parseSkillContent(content, fullPath, client);
        const previous = seenIds.get(skill.id);
        if (previous) {
          onWarning?.(`duplicate skill id "${skill.id}": "${previous}" wins over "${fullPath}"`);
          continue;
        }
        seenIds.set(skill.id, fullPath);
        discovered.push(skill);
      }
    }
  }
}

/**
 * Discovers Copilot and agent plugins (e.g. plugin.json).
 */
export async function discoverPlugins(options: DiscoveryOptions = {}): Promise<DiscoveredPlugin[]> {
  const discovered: DiscoveredPlugin[] = [];
  const candidatePaths: string[] = [];

  if (options.customPaths) {
    for (const custom of options.customPaths) {
      const customPath = typeof custom === "string" ? custom : custom.path;
      if (basename(customPath) === "plugin.json") {
        candidatePaths.push(customPath);
      } else {
        candidatePaths.push(resolve(customPath, "plugin.json"));
      }
    }
  }

  if (!options.skipDefaults) {
    const cwd = options.cwd ?? process.cwd();
    const home = options.home ?? homedir();

    candidatePaths.push(
      resolve(cwd, "plugin.json"),
      resolve(cwd, "packages", "copilot-plugin", "plugin.json"),
      resolve(home, ".copilot", "plugins"),
    );
  }

  const seenManifests = new Set<string>();

  for (const target of candidatePaths) {
    try {
      const st = await stat(target);
      if (st.isDirectory()) {
        const entries = await readdir(target, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const manifest = join(target, entry.name, "plugin.json");
            await parseAndAddPlugin(manifest, discovered, seenManifests);
          }
        }
      } else if (st.isFile()) {
        await parseAndAddPlugin(target, discovered, seenManifests);
      }
    } catch {
      // Candidate not found
    }
  }

  return discovered;
}

async function parseAndAddPlugin(
  manifestPath: string,
  discovered: DiscoveredPlugin[],
  seen: Set<string>,
): Promise<void> {
  if (seen.has(manifestPath)) return;
  try {
    const content = await readFile(manifestPath, "utf8");
    const doc = JSON.parse(content) as Record<string, unknown>;
    const name = typeof doc["name"] === "string" ? doc["name"] : basename(dirname(manifestPath));
    const id = typeof doc["id"] === "string" ? doc["id"] : name;
    const description = typeof doc["description"] === "string" ? doc["description"] : undefined;
    const version = typeof doc["version"] === "string" ? doc["version"] : undefined;

    // Servers from plugin
    const servers: ServerConfig[] = [];
    const pluginDir = dirname(manifestPath);

    // 1. Referenced or direct servers in plugin.json
    if (typeof doc["mcpServers"] === "string") {
      const referencedMcp = resolve(pluginDir, doc["mcpServers"]);
      try {
        const mcpContent = await readFile(referencedMcp, "utf8");
        const mcpDoc = JSON.parse(mcpContent) as Record<string, unknown>;
        const parsed = parseMcpServersBlock(mcpDoc, referencedMcp, "copilot");
        for (const s of parsed) {
          if (!servers.some((existing) => existing.id === s.id)) {
            servers.push(s);
          }
        }
      } catch {
        // Referenced mcpServers file not found
      }
    } else if (doc["mcpServers"] || doc["servers"]) {
      const parsed = parseMcpServersBlock(doc, manifestPath, "copilot");
      servers.push(...parsed);
    }

    // 2. Adjacent .mcp.json
    const adjacentMcp = join(pluginDir, ".mcp.json");
    try {
      const mcpContent = await readFile(adjacentMcp, "utf8");
      const mcpDoc = JSON.parse(mcpContent) as Record<string, unknown>;
      const parsed = parseMcpServersBlock(mcpDoc, adjacentMcp, "copilot");
      for (const s of parsed) {
        if (!servers.some((existing) => existing.id === s.id)) {
          servers.push(s);
        }
      }
    } catch {
      // No adjacent .mcp.json
    }

    // Skills from plugin (supports arrays or directory string like "skills/")
    const skills: SkillConfig[] = [];
    const skillCandidates: string[] = [];
    if (typeof doc["skills"] === "string") {
      skillCandidates.push(doc["skills"]);
    } else if (Array.isArray(doc["skills"])) {
      for (const item of doc["skills"]) {
        if (typeof item === "string") skillCandidates.push(item);
      }
    }

    const seenSkillIds = new Set<string>();
    for (const item of skillCandidates) {
      const resolved = resolve(pluginDir, item);
      try {
        const st = await stat(resolved);
        if (st.isDirectory()) {
          const directSkillMd = join(resolved, "SKILL.md");
          try {
            const skillContent = await readFile(directSkillMd, "utf8");
            const parsedSkill = parseSkillContent(skillContent, directSkillMd, "copilot");
            if (!seenSkillIds.has(parsedSkill.id)) {
              seenSkillIds.add(parsedSkill.id);
              skills.push(parsedSkill);
            }
          } catch {
            // Not directly a skill directory
          }

          const entries = await readdir(resolved, { withFileTypes: true });
          for (const entry of entries) {
            const childPath = join(resolved, entry.name);
            if (entry.isDirectory()) {
              const childSkillMd = join(childPath, "SKILL.md");
              try {
                const skillContent = await readFile(childSkillMd, "utf8");
                const parsedSkill = parseSkillContent(skillContent, childSkillMd, "copilot");
                if (!seenSkillIds.has(parsedSkill.id)) {
                  seenSkillIds.add(parsedSkill.id);
                  skills.push(parsedSkill);
                }
              } catch {
                // No SKILL.md
              }
            } else if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".mdc"))) {
              if (entry.name !== "SKILL.md") {
                try {
                  const skillContent = await readFile(childPath, "utf8");
                  const parsedSkill = parseSkillContent(skillContent, childPath, "copilot");
                  if (!seenSkillIds.has(parsedSkill.id)) {
                    seenSkillIds.add(parsedSkill.id);
                    skills.push(parsedSkill);
                  }
                } catch {
                  // File unreadable
                }
              }
            }
          }
        } else if (st.isFile()) {
          const skillContent = await readFile(resolved, "utf8");
          const parsedSkill = parseSkillContent(skillContent, resolved, "copilot");
          if (!seenSkillIds.has(parsedSkill.id)) {
            seenSkillIds.add(parsedSkill.id);
            skills.push(parsedSkill);
          }
        }
      } catch {
        // Path missing
      }
    }

    seen.add(manifestPath);
    discovered.push({
      id,
      name,
      description,
      version,
      manifestPath,
      servers,
      skills,
    });
  } catch {
    // Malformed plugin manifest
  }
}

/**
 * Unified discovery for MCP servers, skills, and plugins across the environment.
 */
export async function discoverAll(options: DiscoveryOptions = {}): Promise<{
  servers: DiscoveredServer[];
  skills: DiscoveredSkill[];
  plugins: DiscoveredPlugin[];
}> {
  const [servers, skills, plugins] = await Promise.all([
    discoverMcpServers(options),
    discoverSkills(options),
    discoverPlugins(options),
  ]);

  return { servers, skills, plugins };
}
