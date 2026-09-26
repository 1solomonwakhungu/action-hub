#!/usr/bin/env node

import { doctorCommand } from "./commands/doctor.js";
import { authCommand } from "./commands/auth.js";
import type { AuthAction } from "./commands/auth.js";
import { importCommand } from "./commands/import.js";
import { migrateCommand } from "./commands/migrate.js";
import { testSearchCommand } from "./commands/test-search.js";
import { listCommand } from "./commands/list.js";
import { bundlesCommand } from "./commands/bundles.js";
import { startCommand } from "./commands/start.js";
import { serveCommand } from "./commands/serve.js";
import {
  connectCommand,
  daemonStartCommand,
  daemonStatusCommand,
  daemonStopCommand,
  runDaemonProcess,
} from "./commands/daemon.js";
import { VERSION } from "./version.js";
import { IMPORT_SOURCE_FILTERS, type ImportSourceFilter } from "./commands/import.js";
import { MIGRATE_SOURCE_FILTERS, type MigrateSourceFilter } from "./commands/migrate.js";

/** Validates a raw --source CLI value (including "all") against the allowed filter list. */
function parseSourceFilter<S extends string>(
  raw: string | undefined,
  allowed: readonly S[],
): S | "all" | undefined {
  if (!raw) return undefined;
  if (raw === "all") return "all";
  if (!(allowed as readonly string[]).includes(raw)) {
    console.error(
      `Unknown --source value "${raw}". Supported sources: ${allowed.join(", ")}, all`,
    );
    return undefined;
  }
  return raw as S;
}

function printHelp(): void {
  console.log(`
Action Hub Developer CLI (v${VERSION})

USAGE:
  action-hub <command> [options]

COMMANDS:
  doctor              Run system diagnostics, config validation, and server connectivity checks
  auth <action>       Manage OAuth 2.0 credentials for remote servers (login, status, logout)
  migrate             Migrate external MCP servers, agent skills, and plugins into Action Hub
  import              Discover and import MCP server configurations from Claude, Cursor, VS Code, Codex, Windsurf, Cline, and Roo Code
  test-search <query> Search the semantic and keyword catalog with score breakdowns
  list                List all registered tools, skills, and bundles
  bundle              Inspect registered action bundles
  start               Start an isolated Action Hub MCP server in foreground stdio mode
  serve               Serve the Action Hub MCP server over streamable HTTP (127.0.0.1, bearer-token protected)
  connect             Proxy stdio to the shared Action Hub daemon
  daemon <command>    Manage the shared daemon: start, status, or stop

OPTIONS:
  --config <path>     Path to custom Action Hub configuration file (servers.json)
  --help, -h          Show this help message
  --version, -v       Show version

DAEMON:
  daemon start        Start the per-user background daemon
  daemon status       Verify the daemon over its authenticated endpoint
  daemon stop         Gracefully stop the daemon and downstream servers
  connect             Bridge this process's stdio to the daemon

MIGRATE OPTIONS:
  --type <type>       Capability types to migrate: all, mcps, skills, plugins (default: all)
  --source <source>   Filter by source: claude-desktop, cursor, vscode, copilot, agents, codex, windsurf, cline, roo-code, all

IMPORT OPTIONS:
  --source <source>   Filter by source: claude-desktop, cursor, vscode, copilot, codex, windsurf, cline, roo-code, all
  --write             Commit migrated capabilities to config (default is dry-run)
  --overwrite         Overwrite existing servers or skills on ID conflict
  --json              Output plan and results in JSON format

AUTH OPTIONS:
  --no-browser        Print the authorization URL instead of opening a browser
  --timeout <secs>    Seconds to wait for the authorization callback (default: 300)

EXAMPLES:
  action-hub doctor
  action-hub auth status
  action-hub auth login github
  action-hub auth logout github
  action-hub migrate --type all
  action-hub migrate --type skills --write
  action-hub import --write
  action-hub test-search "create pull request" --limit 5
  action-hub list --server github
  action-hub bundle --load triage-issue
  action-hub start
  action-hub serve --port 6290
  action-hub daemon start
  action-hub connect
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log(`action-hub ${VERSION}`);
    process.exit(0);
  }

  const command = args[0];
  const rest = args.slice(1);

  // Simple CLI argument parsing
  const parsedArgs: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (i + 1 < rest.length && !rest[i + 1]!.startsWith("-")) {
        parsedArgs[key] = rest[i + 1]!;
        i++;
      } else {
        parsedArgs[key] = true;
      }
    } else if (arg.startsWith("-")) {
      parsedArgs[arg.slice(1)] = true;
    } else {
      positional.push(arg);
    }
  }

  const configPath = typeof parsedArgs["config"] === "string" ? parsedArgs["config"] : undefined;

  try {
    let exitCode = 0;
    switch (command) {
      case "doctor": {
        exitCode = await doctorCommand({
          configPath,
          checkConnectivity: parsedArgs["no-check"] ? false : true,
        });
        break;
      }

      case "auth": {
        const action = positional[0];
        if (action !== "login" && action !== "status" && action !== "logout") {
          console.error("Usage: action-hub auth <login|status|logout> [server-id]");
          exitCode = 1;
          break;
        }
        const timeoutVal =
          typeof parsedArgs["timeout"] === "string"
            ? Number.parseInt(parsedArgs["timeout"], 10)
            : undefined;
        exitCode = await authCommand(action as AuthAction, positional[1], {
          configPath,
          noBrowser: Boolean(parsedArgs["no-browser"]),
          timeoutSeconds: Number.isFinite(timeoutVal) ? timeoutVal : undefined,
        });
        break;
      }

      case "migrate": {
        const typeVal = typeof parsedArgs["type"] === "string" ? parsedArgs["type"] : undefined;
        const sourceArg = parsedArgs["source"];
        const sourceVal = typeof sourceArg === "string" ? sourceArg : undefined;
        if (sourceArg !== undefined && (typeof sourceArg !== "string" || sourceArg.trim() === "")) {
          // Missing or invalid value: never run an unfiltered migration.
          console.error("Missing value for --source");
          exitCode = 1;
          break;
        }
        const sourceFilter = parseSourceFilter(sourceVal, MIGRATE_SOURCE_FILTERS);
        if (sourceVal !== undefined && sourceFilter === undefined) {
          // Stop before invoking the command: never run an unfiltered migration.
          exitCode = 1;
          break;
        }
        exitCode = await migrateCommand({
          configPath,
          type: typeVal as any,
          source: sourceFilter,
          write: Boolean(parsedArgs["write"]),
          overwrite: Boolean(parsedArgs["overwrite"]),
          json: Boolean(parsedArgs["json"]),
        });
        break;
      }

      case "import": {
        const sourceArg = parsedArgs["source"];
        const sourceVal = typeof sourceArg === "string" ? sourceArg : undefined;
        if (sourceArg !== undefined && (typeof sourceArg !== "string" || sourceArg.trim() === "")) {
          // Missing or invalid value: never run an unfiltered import.
          console.error("Missing value for --source");
          exitCode = 1;
          break;
        }
        const sourceFilter = parseSourceFilter(sourceVal, IMPORT_SOURCE_FILTERS);
        if (sourceVal !== undefined && sourceFilter === undefined) {
          // Stop before invoking the command: never run an unfiltered import.
          exitCode = 1;
          break;
        }
        exitCode = await importCommand({
          configPath,
          source: sourceFilter,
          write: Boolean(parsedArgs["write"]),
        });
        break;
      }

      case "test-search": {
        const query = positional.join(" ");
        const limitVal = typeof parsedArgs["limit"] === "string" ? parseInt(parsedArgs["limit"], 10) : undefined;
        const thresholdVal = typeof parsedArgs["threshold"] === "string" ? parseFloat(parsedArgs["threshold"]) : undefined;
        const serverVal = typeof parsedArgs["server"] === "string" ? parsedArgs["server"] : undefined;

        exitCode = await testSearchCommand(query, {
          configPath,
          limit: limitVal,
          threshold: thresholdVal,
          server: serverVal,
        });
        break;
      }

      case "list": {
        const serverVal = typeof parsedArgs["server"] === "string" ? parsedArgs["server"] : undefined;
        const kindVal = typeof parsedArgs["kind"] === "string" ? (parsedArgs["kind"] as any) : undefined;

        exitCode = await listCommand({
          configPath,
          server: serverVal,
          kind: kindVal,
        });
        break;
      }

      case "bundle":
      case "bundles": {
        const loadVal = typeof parsedArgs["load"] === "string" ? parsedArgs["load"] : positional[0];
        exitCode = await bundlesCommand({
          configPath,
          load: loadVal,
        });
        break;
      }

      case "start": {
        exitCode = await startCommand({
          configPath,
        });
        break;
      }

      case "serve": {
        const portVal = typeof parsedArgs["port"] === "string" ? Number.parseInt(parsedArgs["port"], 10) : undefined;
        exitCode = await serveCommand({
          configPath,
          port: Number.isFinite(portVal) ? portVal : undefined,
        });
        break;
      }

      case "connect": {
        exitCode = await connectCommand({
          configPath,
        });
        break;
      }

      case "daemon": {
        const subcommand = positional[0];
        if (subcommand === "start") {
          exitCode = await daemonStartCommand({ configPath });
        } else if (subcommand === "status") {
          exitCode = await daemonStatusCommand({ configPath });
        } else if (subcommand === "stop") {
          exitCode = await daemonStopCommand({ configPath });
        } else {
          console.error("Usage: action-hub daemon <start|status|stop>");
          exitCode = 1;
        }
        break;
      }

      case "__daemon-run": {
        await runDaemonProcess();
        exitCode = 0;
        break;
      }

      default: {
        console.error(`Unknown command: "${command}". Run \`action-hub --help\` for available commands.`);
        exitCode = 1;
      }
    }

    process.exit(exitCode);
  } catch (err) {
    console.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
