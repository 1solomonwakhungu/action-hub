import { mkdir, readFile, realpathSync, writeFile, copyFile } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { parse as tomlParse, stringify as tomlStringify } from "smol-toml";

const copyFileP = promisify(copyFile);
const mkdirP = promisify(mkdir);
const readFileP = promisify(readFile);
const writeFileP = promisify(writeFile);

/**
 * `action-hub harness` — connect any AI harness (Claude Code, Claude Desktop,
 * Cursor, Codex, OpenCode, VS Code) to Action Hub with one command.
 *
 * Grammar:
 *   action-hub harness <target>             # print the config snippet (export)
 *   action-hub harness <target> [export]    # same, explicitly
 *   action-hub harness <target> install     # write it into the harness config
 *                                           # (requires --write)
 *
 * Install mode:
 *   - writes a timestamped `.bak` of the config before touching it (a backup
 *     failure aborts before the config is modified)
 *   - fails (exit 1) if the existing config is malformed JSON/TOML or cannot
 *     be read — it never overwrites bytes it cannot parse
 *   - updates an existing `action-hub` entry in place; all other entries are
 *     preserved (Codex config.toml comments are not preserved; the .bak keeps
 *     the original)
 *   - `--config <path>` is exported as ACTION_HUB_CONFIG in the snippet
 *
 * The emitted server command runs this CLI itself (`action-hub start`), so it
 * works both from a repo checkout (node <realpath of CLI entry>, start) and a
 * standalone binary (process.execPath, start when running as a single
 * executable application).
 */

export type HarnessName =
  | "claude-code"
  | "claude-desktop"
  | "cursor"
  | "codex"
  | "opencode"
  | "vscode";

export const SUPPORTED_HARNESSES: readonly HarnessName[] = [
  "claude-code",
  "claude-desktop",
  "cursor",
  "codex",
  "opencode",
  "vscode",
];

export type HarnessMode = "export" | "install";

export interface HarnessOptions {
  write?: boolean;
  json?: boolean;
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
  serversKey: string;
}

/** Build the command that runs this CLI's `start` subcommand. */
async function cliServerEntry(configPath?: string): Promise<ServerEntry> {
  // Standalone (SEA) binary: process.execPath, start.
  // Node entrypoint: node <realpath of this CLI>, start.
  let sea: { isSea?: () => boolean } | undefined;
  try {
    sea = (await import("node:sea")) as { isSea?: () => boolean };
  } catch {
    /* Node without node:sea */
  }
  const inSea = typeof sea?.isSea === "function" && sea.isSea();
  const args = inSea
    ? ["start"]
    : [realpathSync(process.argv[1] ?? "action-hub"), "start"];
  const entry: ServerEntry = { command: process.execPath, args };
  if (configPath) {
    entry.env = { ACTION_HUB_CONFIG: configPath };
  }
  return entry;
}

function defaultConfigPath(): string {
  const configured = process.env.ACTION_HUB_CONFIG;
  if (configured) return configured;
  return join(homedir(), ".config", "action-hub", "servers.json");
}

export const HARNESS_DEFS: Record<HarnessName, HarnessDef> = {
  "claude-code": {
    label: "Claude Code",
    configPath: (home: string) => join(home, ".claude.json"),
    format: "json",
    serversKey: "mcpServers",
  },
  "claude-desktop": {
    label: "Claude Desktop",
    configPath: (home: string) => {
      if (process.platform === "darwin") {
        return join(
          home,
          "Library",
          "Application Support",
          "Claude",
          "claude_desktop_config.json",
        );
      }
      if (process.platform === "win32") {
        return join(
          process.env.APPDATA ?? join(home, "AppData", "Roaming"),
          "Claude",
          "claude_desktop_config.json",
        );
      }
      return join(home, ".config", "Claude", "claude_desktop_config.json");
    },
    format: "json",
    serversKey: "mcpServers",
  },
  cursor: {
    label: "Cursor",
    configPath: (home: string) => join(home, ".cursor", "mcp.json"),
    format: "json",
    serversKey: "mcpServers",
  },
  codex: {
    label: "Codex CLI",
    configPath: (home: string) => join(home, ".codex", "config.toml"),
    format: "toml",
    serversKey: "mcp_servers",
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
  },
  vscode: {
    label: "VS Code",
    configPath: (home: string) => {
      // User-profile mcp.json; the default profile lives in the VS Code user
      // folder (https://code.visualstudio.com/docs/copilot/customize/mcp-servers).
      if (process.platform === "darwin") {
        return join(
          home,
          "Library",
          "Application Support",
          "Code",
          "User",
          "mcp.json",
        );
      }
      if (process.platform === "win32") {
        return join(
          process.env.APPDATA ?? join(home, "AppData", "Roaming"),
          "Code",
          "User",
          "mcp.json",
        );
      }
      return join(home, ".config", "Code", "User", "mcp.json");
    },
    format: "json",
    serversKey: "servers",
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
  } catch (err) {
    // Only a missing file means "first install"; any other read error
    // (permissions, is-a-directory, I/O) must abort before we mutate config.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    throw err;
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

/** The JSON entry shape a harness expects for its servers key. */
function jsonEntryFor(
  serversKey: string,
  serverEntry: ServerEntry,
): JsonEntry {
  if (serversKey === "mcp") {
    // OpenCode local-server schema (opencode.ai/docs/mcp-servers/).
    const entry: JsonEntry = {
      type: "local",
      command: [serverEntry.command, ...serverEntry.args],
    };
    if (serverEntry.env) entry.environment = serverEntry.env;
    return entry;
  }
  return serverEntry as unknown as JsonEntry;
}

// ---------------------------------------------------------------------------
// TOML handling (codex config.toml) — via smol-toml, no hand-rolled parsing
// ---------------------------------------------------------------------------

async function readTomlDoc(filePath: string): Promise<Record<string, unknown>> {
  let raw = "";
  try {
    raw = await readFileP(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    throw err;
  }
  if (raw.trim() === "") return {};
  try {
    const parsed = tomlParse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("config root is not a TOML table");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Failed to parse existing config at ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }. Refusing to modify a config we cannot parse.`,
    );
  }
}

/** Replace an existing `[mcp_servers.action-hub]` table, or add a new one. */
function upsertTomlEntry(
  doc: Record<string, unknown>,
  entry: ServerEntry,
): Record<string, unknown> {
  const existing = doc["mcp_servers"];
  const servers =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  servers["action-hub"] = entry;
  return { ...doc, mcp_servers: servers };
}

// ---------------------------------------------------------------------------
// Install mode
// ---------------------------------------------------------------------------

/** Write a timestamped `.bak` copy of filePath before modifying it. */
async function backupFile(filePath: string): Promise<void> {
  try {
    await readFileP(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return; // No original file (first install) — nothing to back up.
    }
    throw err; // Unreadable original: abort rather than modify without a backup.
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await copyFileP(filePath, `${filePath}.bak-${stamp}`); // failures propagate
}

async function installJson(
  def: HarnessDef,
  filePath: string,
  entry: JsonEntry,
): Promise<string> {
  const doc = await readJsonFile(filePath);
  const updated = upsertJsonEntry(doc, def.serversKey, entry);

  await backupFile(filePath);
  await mkdirP(dirname(filePath), { recursive: true });
  await writeFileP(filePath, JSON.stringify(updated, null, 2) + "\n", "utf8");
  return filePath;
}

async function installToml(
  filePath: string,
  entry: ServerEntry,
): Promise<string> {
  const doc = await readTomlDoc(filePath);
  const updated = upsertTomlEntry(doc, entry);

  await backupFile(filePath);
  await mkdirP(dirname(filePath), { recursive: true });
  // NOTE: smol-toml stringify drops comments — the .bak keeps the original.
  await writeFileP(filePath, tomlStringify(updated) + "\n", "utf8");
  return filePath;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

function fail(message: string): number {
  console.error(`error: ${message}`);
  console.error(`supported harnesses: ${SUPPORTED_HARNESSES.join(", ")}`);
  return 1;
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
    return fail(`unknown harness "${target}"`);
  }

  const mode: HarnessMode = options.mode ?? (options.write ? "install" : "export");
  if (mode === "install" && options.write !== true) {
    return fail(
      `install mode requires --write (refusing to modify ${def.configPath(homedir())} without it)`,
    );
  }

  const serverEntry = await cliServerEntry(options.configPath);

  if (mode === "install") {
    const filePath = def.configPath(homedir());
    try {
      if (def.format === "toml") {
        await installToml(filePath, serverEntry);
      } else {
        await installJson(def, filePath, jsonEntryFor(def.serversKey, serverEntry));
      }
    } catch (err) {
      return fail(
        `${err instanceof Error ? err.message : String(err)} (config left untouched)`,
      );
    }
    console.log(`Wrote Action Hub MCP server to ${filePath} for ${def.label}.`);
    return 0;
  }

  // export mode — print ONLY the Action Hub fragment for this target.
  // The existing target config is deliberately never read here: it may
  // contain unrelated secrets that must not be echoed to the terminal.
  // (install mode reads and merges; export must not.)
  if (options.json && def.format === "toml") {
    return fail("--json is only supported for JSON-format targets (codex emits TOML)");
  }
  if (def.format === "toml") {
    console.log(
      `# ${def.label} — add to ${def.configPath(homedir())} (install with --write; existing comments are not preserved by the rewrite, the .bak keeps them)`,
    );
    console.log(tomlStringify({ mcp_servers: { "action-hub": serverEntry } }));
  } else {
    const fragment = upsertJsonEntry(
      {},
      def.serversKey,
      jsonEntryFor(def.serversKey, serverEntry),
    );
    console.log(JSON.stringify(fragment, null, 2));
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
  --json          (export, JSON targets only) Print only the JSON document,
                  no commentary. Rejected for TOML targets (codex).

Examples:
  action-hub harness cursor                 # print Cursor's mcp.json snippet
  action-hub harness claude-code install --write
  action-hub harness codex install --write --config ~/.config/action-hub/servers.json
`);
}
