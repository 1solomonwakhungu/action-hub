import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type HarnessName =
  | "claude-code"
  | "claude-desktop"
  | "cursor"
  | "codex"
  | "opencode"
  | "pi"
  | "vscode";

export const SUPPORTED_HARNESSES: HarnessName[] = [
  "claude-code",
  "claude-desktop",
  "cursor",
  "codex",
  "opencode",
  "pi",
  "vscode",
];

export interface HarnessOptions {
  write?: boolean;
  json?: boolean;
  command?: string;
  configPath?: string;
}

interface HarnessDefinition {
  /** Human readable harness name */
  label: string;
  /** Path to the harness config file (may not exist yet) */
  configPath: (home: string) => string;
  /** Config file format */
  format: "json" | "toml";
  /** True if the config file is a shared file used by several harnesses (VS Code / Cursor style mcp.json) */
  shared?: boolean;
  /**
   * Produce the entry object for `mcpServers` (JSON format) — for TOML formats this is unused.
   */
  jsonEntry?: () => Record<string, unknown>;
  /**
   * Produce the full expected JSON document given the existing config (or empty).
   */
  jsonDocument?: (existing: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Produce the TOML snippet to print for export.
   */
  tomlSnippet?: (command: string) => string;
  /** For export: print a JSON snippet (subset of full document) */
  jsonSnippet?: (command: string) => string;
}

function findServerScript(explicitCommand?: string): string {
  if (explicitCommand) {
    if (isAbsolute(explicitCommand)) return explicitCommand;
    return resolve(process.cwd(), explicitCommand);
  }
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const possiblePaths = [
    resolve(__dirname, "../../copilot-plugin/server/dist/index.js"),
    resolve(__dirname, "../../../copilot-plugin/server/dist/index.js"),
  ];
  for (const p of possiblePaths) {
    if (existsSync(p)) return p;
  }
  // Fall back to a relative, user-facing path (portable across machines).
  return "node packages/copilot-plugin/server/dist/index.js";
}

interface ServerEntry {
  command: string;
  args: string[];
}

function buildServerEntry(serverScript: string): ServerEntry {
  if (serverScript.endsWith(".js") && existsSync(serverScript)) {
    return { command: process.execPath, args: [serverScript] };
  }
  // Portable relative invocation
  return { command: "node", args: [serverScript.replace(/^node\s+/, "")] };
}

function snippetJson(entry: ServerEntry): string {
  return JSON.stringify({ mcpServers: { "action-hub": { ...entry } } }, null, 2);
}

const HARNESS_DEFS: Record<HarnessName, HarnessDefinition> = {
  "claude-code": {
    label: "Claude Code",
    format: "json",
    configPath: (home: string) => resolve(home, ".claude.json"),
    jsonDocument: (existing: Record<string, unknown>) => {
      const doc = { ...existing };
      const servers = { ...((doc["mcpServers"] as Record<string, unknown>) ?? {}) };
      doc["mcpServers"] = servers;
      return doc;
    },
    jsonSnippet: () => snippetJson,
  } as unknown as HarnessDefinition,
  "claude-desktop": {
    label: "Claude Desktop",
    format: "json",
    configPath: (home: string) =>
      process.platform === "darwin"
        ? resolve(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
        : resolve(home, ".config", "Claude", "claude_desktop_config.json"),
    jsonDocument: (existing: Record<string, unknown>) => {
      const doc = { ...existing };
      const servers = { ...((doc["mcpServers"] as Record<string, unknown>) ?? {}) };
      doc["mcpServers"] = servers;
      return doc;
    },
    jsonSnippet: () => snippetJson,
  } as unknown as HarnessDefinition,
  cursor: {
    label: "Cursor",
    format: "json",
    configPath: (home: string) => resolve(home, ".cursor", "mcp.json"),
    jsonDocument: (existing: Record<string, unknown>) => {
      const doc = { ...existing };
      const servers = { ...((doc["mcpServers"] as Record<string, unknown>) ?? {}) };
      doc["mcpServers"] = servers;
      return doc;
    },
    jsonSnippet: () => snippetJson,
  } as unknown as HarnessDefinition,
  codex: {
    label: "Codex CLI",
    format: "toml",
    configPath: (home: string) => resolve(home, ".codex", "config.toml"),
    tomlSnippet: () => `[mcp_servers.action-hub]
command = "node"
args = ["<path-to>/packages/copilot-plugin/server/dist/index.js"]
`,
  },
  opencode: {
    label: "OpenCode",
    format: "json",
    configPath: (home: string) => resolve(home, ".config", "opencode", "opencode.json"),
    jsonDocument: (existing: Record<string, unknown>) => {
      const doc = { ...existing };
      const servers = { ...((doc["mcp"] as Record<string, unknown>) ?? {}) };
      doc["mcp"] = servers;
      return doc;
    },
    jsonSnippet: () =>
      JSON.stringify({ mcp: { "action-hub": { type: "local", command: ["node", "<path>/index.js"] } } }, null, 2),
  },
  pi: {
    label: "Pi",
    format: "json",
    configPath: (home: string) => resolve(home, ".pi", "mcp.json"),
    jsonDocument: (existing: Record<string, unknown>) => {
      const doc = { ...existing };
      const servers = { ...((doc["mcpServers"] as Record<string, unknown>) ?? {}) };
      doc["mcpServers"] = servers;
      return doc;
    },
    jsonSnippet: () => snippetJson,
  } as unknown as HarnessDefinition,
  vscode: {
    label: "VS Code",
    format: "json",
    configPath: (home: string) =>
      resolve(home, "Library", "Application Support", "Code", "User", "mcp.json"),
    jsonDocument: (existing: Record<string, unknown>) => {
      const doc = { ...existing };
      const servers = { ...((doc["servers"] as Record<string, unknown>) ?? {}) };
      doc["servers"] = servers;
      return doc;
    },
    jsonSnippet: () =>
      JSON.stringify({ servers: { "action-hub": { type: "stdio", command: "node", args: ["<path>/index.js"] } } }, null, 2),
  },
};

function normalizeSubkey(harness: HarnessName, doc: Record<string, unknown>): Record<string, unknown> {
  switch (harness) {
    case "opencode":
      return (doc["mcp"] as Record<string, unknown>) ?? {};
    case "vscode":
      return (doc["servers"] as Record<string, unknown>) ?? {};
    default:
      return (doc["mcpServers"] as Record<string, unknown>) ?? {};
  }
}

function subkeyName(harness: HarnessName): string {
  switch (harness) {
    case "opencode":
      return "mcp";
    case "vscode":
      return "servers";
    default:
      return "mcpServers";
  }
}

function entryFor(harness: HarnessName, entry: ServerEntry): Record<string, unknown> {
  switch (harness) {
    case "opencode":
      return { type: "local", command: [entry.command, ...entry.args] };
    case "vscode":
      return { type: "stdio", command: entry.command, args: entry.args };
    default:
      return { command: entry.command, args: entry.args };
  }
}

function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function harnessCommand(
  target: string | undefined,
  options: HarnessOptions = {},
): Promise<number> {
  const sub = target;

  if (!sub || sub === "help" || sub === "--help") {
    printHarnessHelp();
    return sub ? 0 : 0;
  }

  if (sub === "list") {
    console.log("Supported harnesses:");
    for (const h of SUPPORTED_HARNESSES) console.log(`  ${h}`);
    return 0;
  }

  const parts = sub.split(":") as [string, string] | [string];
  const harness = parts[0] as HarnessName;

  if (!SUPPORTED_HARNESSES.includes(harness)) {
    console.error(
      `Unsupported harness "${harness}". Supported: ${SUPPORTED_HARNESSES.join(", ")}. Run \`action-hub harness --help\` for usage.`,
    );
    return 1;
  }

  const mode = parts[1] ?? "export";
  if (mode !== "export" && mode !== "install") {
    console.error(`Unknown mode "${mode}". Use "export" or "install".`);
    return 1;
  }

  const def = HARNESS_DEFS[harness];
  const serverScript = findServerScript(options.command);
  const home = homedir();
  const configPath = def.configPath(home);

  // Build the concrete server entry
  const serverEntry = buildServerEntry(serverScript);

  if (mode === "export") {
    if (def.format === "json") {
      const doc = def.jsonDocument!({});
      const entry = entryFor(harness, serverEntry);
      (doc as any)[subkeyName(harness)]["action-hub"] = entry;
      console.log(JSON.stringify(doc, null, 2));
    } else {
      const snippet = def.tomlSnippet!(serverEntry.args[0] ?? "node");
      console.log(
        snippet.replace(
          '"<path-to>/packages/copilot-plugin/server/dist/index.js"',
          JSON.stringify(serverEntry.args[0] ?? serverScript),
        ),
      );
    }
    console.error(`\n# Config file: ${configPath}`);
    return 0;
  }

  // install mode
  if (!options.write) {
    if (def.format === "json") {
      const doc = def.jsonDocument!({});
      const entry = entryFor(harness, serverEntry);
      (doc as any)[subkeyName(harness)]["action-hub"] = entry;
      console.log(JSON.stringify(doc, null, 2));
    } else {
      const snippet = def.tomlSnippet!(serverEntry.args[0] ?? "node");
      console.log(
        snippet.replace(
          '"<path-to>/packages/copilot-plugin/server/dist/index.js"',
          JSON.stringify(serverEntry.args[0] ?? serverScript),
        ),
      );
    }
    console.error(
      `\n# Dry run (no --write). Would write: ${configPath}\n# Re-run with --write to apply.`,
    );
    return 0;
  }

  if (def.format === "toml") {
    // For TOML (codex) we append to the existing file rather than rewriting it,
    // since we do not have a full TOML parser/serializer.
    mkdirSync(dirname(configPath), { recursive: true });
    const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
    if (existing.includes("[mcp_servers.action-hub]")) {
      console.error(`action-hub entry already present in ${configPath}; nothing to do.`);
      return 0;
    }
    const block = `[mcp_servers.action-hub]\ncommand = ${JSON.stringify(serverEntry.command)}\nargs = [${serverEntry.args
      .map((a) => JSON.stringify(a))
      .join(", ")}]\n`;
    writeFileSync(configPath, existing.endsWith("\n") || existing === "" ? existing + block : existing + "\n" + block);
    console.error(`Wrote action-hub entry to ${configPath}`);
    return 0;
  }

  // JSON harnesses: read existing doc, merge entry, write back
  const existingDoc = readJsonFile(configPath);
  const doc = def.jsonDocument!(existingDoc);
  const servers = normalizeSubkey(harness, doc);
  if ("action-hub" in servers) {
    console.error(`action-hub entry already present in ${configPath}; nothing to do.`);
    return 0;
  }
  servers["action-hub"] = entryFor(harness, serverEntry);
  (doc as any)[subkeyName(harness)] = servers;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(doc, null, 2) + "\n");
  console.error(`Wrote action-hub entry to ${configPath}`);
  return 0;
}

function printHarnessHelp(): void {
  console.log(`
USAGE:
  action-hub harness <mode>:<harness> [options]
  action-hub harness <harness>          (defaults to export)

MODES:
  export    Print the config snippet to stdout (default)
  install   Detect and write/update the target harness config file (requires --write)

HARNESSES:
  ${SUPPORTED_HARNESSES.join(", ")}

OPTIONS:
  --write             Actually write to the harness config file (install mode)
  --command <path>    Explicit path to the Action Hub stdio server script
  --config <path>     Path to custom Action Hub configuration file (passed via env)

EXAMPLES:
  action-hub harness export:cursor
  action-hub harness claude-desktop --write
  action-hub harness install:codex --write
  action-hub harness list
`);
}

export { HARNESS_DEFS };
