import { copyFile, mkdir, readFile, statSync, writeFile } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";

const copyFileP = promisify(copyFile);
const mkdirP = promisify(mkdir);
const readFileP = promisify(readFile);
const writeFileP = promisify(writeFile);

/**
 * `action-hub harness` — connect any AI harness (Claude Code, Claude Desktop,
 * Cursor, Codex, OpenCode, pi, VS Code) to Action Hub with one command.
 *
 * Grammar:
 *   action-hub harness <target>             # print the config snippet (export)
 *   action-hub harness <target> [export]    # same, explicitly
 *   action-hub harness <target> install     # write it into the harness config
 *                                           # (requires --write)
 *
 * Install mode:
 *   - writes a timestamped `.bak` of the config before touching it
 *   - fails (exit 1) if the existing config is malformed JSON/TOML — it never
 *     overwrites bytes it cannot parse
 *   - updates an existing `action-hub` entry in place; all other entries are
 *     preserved
 *   - `--config <path>` is exported as ACTION_HUB_CONFIG in the snippet
 */

export type HarnessName =
  | "claude-code"
  | "claude-desktop"
  | "cursor"
  | "codex"
  | "opencode"
  | "pi"
  | "vscode";

export const SUPPORTED_HARNESSES: readonly HarnessName[] = [
  "claude-code",
  "claude-desktop",
  "cursor",
  "codex",
  "opencode",
  "pi",
  "vscode",
];

export type HarnessMode = "export" | "install";

export interface HarnessOptions {
  write?: boolean;
  json?: boolean;
  command?: string;
  configPath?: string;
  mode?: HarnessMode;
}

/** command/args pair used by most harnesses and by the TOML (codex) writer. */
interface ServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** The object written into a harness's JSON config under the servers key. */
type JsonEntry = Record<string, unknown>;

interface HarnessDef {
  label: string;
  /** Absolute path to the harness config file, given the user's home. */
  configPath: (home: string) => string;
  format: "json" | "toml";
  /** Top-level key under which MCP server entries live (JSON harnesses). */
  serversKey?: string;
  /** TOML table header for the server entry (codex). */
  tomlSection?: (name: string) => string;
  /** Build the entry object this harness expects. */
  entryFor: (server: { command: string; script: string; configPath: string }) => JsonEntry;
}

function serverEntry(server: {
  command: string;
  script: string;
  configPath: string;
}): ServerEntry {
  const entry: ServerEntry = { command: server.command, args: [server.script] };
  if (server.configPath) {
    entry.env = { ACTION_HUB_CONFIG: server.configPath };
  }
  return entry;
}

function defaultConfigPath(): string {
  const configured = process.env.ACTION_HUB_CONFIG;
  if (configured) return configured;
  return join(homedir(), ".config", "action-hub", "servers.json");
}

/** Locate the built MCP server script shipped in this repo. */
function findServerScript(startDir: string): string | null {
  const candidates = [
    resolve(startDir, "../../copilot-plugin/server/dist/index.js"),
    resolve(startDir, "../copilot-plugin/server/dist/index.js"),
    resolve(startDir, "packages/copilot-plugin/server/dist/index.js"),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

const HARNESS_DEFS: Record<HarnessName, HarnessDef> = {
  "claude-code": {
    label: "Claude Code",
    configPath: (home: string) => join(home, ".claude.json"),
    format: "json",
    serversKey: "mcpServers",
    entryFor: (server) => serverEntry(server) as unknown as JsonEntry,
  },
  "claude-desktop": {
    label: "Claude Desktop",
    configPath: (home: string) =>
      process.platform === "darwin"
        ? join(
            home,
            "Library",
            "Application Support",
            "Claude",
            "claude_desktop_config.json",
          )
        : join(home, ".config", "Claude", "claude_desktop_config.json"),
    format: "json",
    serversKey: "mcpServers",
    entryFor: (server) => serverEntry(server) as unknown as JsonEntry,
  },
  cursor: {
    label: "Cursor",
    configPath: (home: string) => join(home, ".cursor", "mcp.json"),
    format: "json",
    serversKey: "mcpServers",
    entryFor: (server) => serverEntry(server) as unknown as JsonEntry,
  },
  codex: {
    label: "Codex CLI",
    configPath: (home: string) => join(home, ".codex", "config.toml"),
    format: "toml",
    tomlSection: (name: string) => `mcp_servers.${name}`,
    entryFor: (server) => serverEntry(server) as unknown as JsonEntry,
  },
  opencode: {
    // Schema per https://opencode.ai/docs/mcp-servers/ : each local MCP
    // server is a key under the top-level `mcp` object with
    // `{ type: "local", command: [<cmd>, ...args], environment?: {...} }` —
    // the command is a single array, not separate command/args fields.
    label: "OpenCode",
    configPath: (home: string) =>
      join(home, ".config", "opencode", "opencode.json"),
    format: "json",
    serversKey: "mcp",
    entryFor: (server) => {
      const entry: JsonEntry = {
        type: "local",
        command: [server.command, server.script],
      };
      if (server.configPath) {
        entry.environment = { ACTION_HUB_CONFIG: server.configPath };
      }
      return entry;
    },
  },
  pi: {
    label: "pi",
    configPath: (home: string) => join(home, ".pi", "mcp.json"),
    format: "json",
    serversKey: "mcpServers",
    entryFor: (server) => serverEntry(server) as unknown as JsonEntry,
  },
  vscode: {
    label: "VS Code",
    configPath: (home: string) =>
      process.platform === "darwin"
        ? join(home, "Library", "Application Support", "Code", "User", "mcp.json")
        : join(home, ".config", "Code", "User", "mcp.json"),
    format: "json",
    serversKey: "servers",
    entryFor: (server) => serverEntry(server) as unknown as JsonEntry,
  },
};

// ---------------------------------------------------------------------------
// JSON handling
// ---------------------------------------------------------------------------

async function readJsonFile(
  filePath: string,
): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFileP(filePath, "utf8");
  } catch {
    // Missing file = empty document (first install).
    return {};
  }
  if (raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse existing config at ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }. Refusing to modify a config we cannot parse.`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Failed to parse existing config at ${filePath}: config root is not a JSON object. Refusing to modify a config we cannot parse.`,
    );
  }
  return parsed as Record<string, unknown>;
}

/** Insert/replace the action-hub entry, preserving every other entry. */
function upsertJsonEntry(
  doc: Record<string, unknown>,
  serversKey: string,
  entry: JsonEntry,
): Record<string, unknown> {
  const existing = doc[serversKey];
  const servers =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  servers["action-hub"] = entry;
  return { ...doc, [serversKey]: servers };
}

// ---------------------------------------------------------------------------
// TOML handling (codex config.toml)
// ---------------------------------------------------------------------------

const TOML_LINE =
  /^\s*(\[\[?[A-Za-z0-9_.\-"']+\]?\]|([A-Za-z0-9_\-."']+)\s*=\s*\S.*)?$/;

/**
 * Lightweight structural validation: every non-empty, non-comment line must
 * be a table header or a `key = value` pair. Catches truncated/corrupted
 * TOML without pulling in a parser dependency.
 */
function validateToml(raw: string, filePath: string): void {
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (!TOML_LINE.test(line)) {
      throw new Error(
        `Failed to parse existing config at ${filePath}: malformed TOML at line ${
          i + 1
        }. Refusing to modify a config we cannot parse.`,
      );
    }
  }
}

/** Serialize a ServerEntry as TOML key/value lines. */
function tomlLines(entry: ServerEntry): string[] {
  return [
    `command = ${JSON.stringify(entry.command)}`,
    `args = ${JSON.stringify(entry.args)}`,
    ...(entry.env ? [`env = ${JSON.stringify(entry.env)}`] : []),
  ];
}

/** Replace an existing `[mcp_servers.action-hub]` table, or append a new one. */
function upsertTomlEntry(
  raw: string,
  section: string,
  entry: ServerEntry,
): string {
  const lines = raw.split("\n");
  const header = `[${section}]`;
  const start = lines.findIndex((l) => l.trim() === header);
  if (start === -1) {
    const body = [
      "",
      `# Action Hub MCP server (managed by \`action-hub harness codex install\`)`,
      header,
      ...tomlLines(entry),
    ];
    const sep = raw.endsWith("\n") || raw === "" ? "" : "\n";
    return raw + sep + body.join("\n") + "\n";
  }
  // Find the end of the existing table (next table header or EOF).
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*\[\[?\s*[A-Za-z0-9_.\-"']+\s*\]?\]/.test(line)) {
      end = i;
      break;
    }
  }
  const updated = [...lines.slice(0, start), header, ...tomlLines(entry), ...lines.slice(end)];
  return updated.join("\n");
}

// ---------------------------------------------------------------------------
// Snippet rendering (export mode)
// ---------------------------------------------------------------------------

function renderTomlSnippet(entry: ServerEntry, section: string): string {
  return [
    `# Add to your Codex config (~/.codex/config.toml)`,
    `[${section}]`,
    ...tomlLines(entry),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Install mode
// ---------------------------------------------------------------------------

/** Write a timestamped `.bak` copy of filePath before modifying it. */
async function backupFile(filePath: string): Promise<void> {
  try {
    await readFileP(filePath, "utf8");
  } catch {
    return; // No original file (first install) — nothing to back up.
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await copyFileP(filePath, `${filePath}.bak-${stamp}`);
}

async function installJson(
  def: HarnessDef,
  filePath: string,
  entry: JsonEntry,
): Promise<string> {
  const doc = await readJsonFile(filePath);
  const updated = upsertJsonEntry(doc, def.serversKey ?? "mcpServers", entry);

  await backupFile(filePath);
  await mkdirP(dirname(filePath), { recursive: true });
  await writeFileP(filePath, JSON.stringify(updated, null, 2) + "\n", "utf8");
  return filePath;
}

async function installToml(
  def: HarnessDef,
  filePath: string,
  entry: ServerEntry,
): Promise<string> {
  let raw = "";
  try {
    raw = await readFileP(filePath, "utf8");
  } catch {
    raw = "";
  }
  if (raw.trim() !== "") {
    validateToml(raw, filePath);
  }
  const section = def.tomlSection?.("action-hub") ?? "mcp_servers.action-hub";
  const updated = upsertTomlEntry(raw, section, entry);

  await backupFile(filePath);
  await mkdirP(dirname(filePath), { recursive: true });
  await writeFileP(filePath, updated, "utf8");
  return filePath;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

function fail(message: string): never {
  console.error(`error: ${message}`);
  console.error(`supported harnesses: ${SUPPORTED_HARNESSES.join(", ")}`);
  process.exit(1);
}

export async function harnessCommand(
  target: string,
  options: HarnessOptions,
): Promise<number> {
  if (target === "help" || target === "--help" || target === "-h") {
    printHarnessHelp();
    return 0;
  }

  const def = HARNESS_DEFS[target as HarnessName];
  if (!def) {
    fail(`unknown harness "${target}"`);
  }

  const mode: HarnessMode = options.mode ?? (options.write ? "install" : "export");
  if (mode === "install" && options.write !== true) {
    fail(`install mode requires --write (refusing to modify ${def.configPath(homedir())} without it)`);
  }

  const script = findServerScript(process.cwd());
  const command = options.command ?? (process.execPath || "node");
  const configPath = options.configPath ?? defaultConfigPath();
  const server = {
    command,
    script: script ?? "<action-hub>/packages/copilot-plugin/server/dist/index.js",
    configPath,
  };
  const entry = def.entryFor(server);

  if (mode === "install") {
    if (!script) {
      fail(
        "cannot locate the Action Hub MCP server build (packages/copilot-plugin/server/dist/index.js). Run `npm run build` first.",
      );
    }
    const filePath = def.configPath(homedir());
    if (def.format === "toml") {
      const written = await installToml(
        def,
        filePath,
        serverEntry(server),
      );
      console.log(`Wrote Action Hub MCP server to ${written} for ${def.label}.`);
    } else {
      const written = await installJson(def, filePath, entry);
      console.log(`Wrote Action Hub MCP server to ${written} for ${def.label}.`);
    }
    return 0;
  }

  // export mode
  if (def.format === "toml") {
    const section = def.tomlSection?.("action-hub") ?? "mcp_servers.action-hub";
    console.log(`# ${def.label} — add to ${def.configPath(homedir())}`);
    console.log(renderTomlSnippet(serverEntry(server), section));
  } else {
    const filePath = def.configPath(homedir());
    const doc = await readJsonFile(filePath);
    const merged = upsertJsonEntry(doc, def.serversKey ?? "mcpServers", entry);
    console.log(JSON.stringify(merged, null, 2));
  }
  if (!options.json) {
    console.log(
      `\n# To write this automatically, run: action-hub harness ${target} install --write`,
    );
  }
  return 0;
}

function printHarnessHelp(): void {
  console.log(`action-hub harness <target> [export|install]

Connect an AI harness to Action Hub by emitting (or writing) the harness's
MCP server configuration.

Targets:
${SUPPORTED_HARNESSES.map((h) => `  ${h.padEnd(16)} ${HARNESS_DEFS[h].label}`).join("\n")}

Modes:
  export          Print the config snippet (default).
  install         Write the snippet into the harness config file.
                  Requires --write as a safety guard.

Options:
  --write         Required for install mode; confirms in-place writes.
  --config <path> Point the harness at a specific Action Hub config file
                  (exported as ACTION_HUB_CONFIG in the snippet).
  --json          (export) Print only the JSON document, no commentary.

Examples:
  action-hub harness cursor                 # print Cursor's mcp.json snippet
  action-hub harness claude-code install --write
  action-hub harness codex install --write --config ~/.config/action-hub/servers.json
`);
}
