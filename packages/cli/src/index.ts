#!/usr/bin/env node

// Command modules are loaded LAZILY (await import) inside their dispatch
// cases: the anchored process tree re-invokes this CLI for hidden internal
// modes (__anchor-run/__wrapper-run), and every CLI load in that chain pays
// the module graph. Lazy imports keep anchor/wrapper invocations — and
// ordinary startup — from loading every command module.
import { ANCHOR_MODE, WRAPPER_MODE, runAnchorProcess, runWrapperProcess } from "./commands/process-anchor.js";
const loadDaemon = (): Promise<typeof import("./commands/daemon.js")> => import("./commands/daemon.js");
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
  harness [target]    Export or install configuration snippets for AI harnesses
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
  --write             Commit migrated capabilities to config (default is dry-run)
  --overwrite         Overwrite existing servers or skills on ID conflict
  --json              Output plan and results in JSON format

IMPORT OPTIONS:
  --source <source>   Filter by source: claude-desktop, cursor, vscode, copilot, codex, windsurf, cline, roo-code, all
  --write             Save discovered servers to the Action Hub config

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
  action-hub bundle --export <id>   Print a bundle as pretty JSON
  action-hub start
  action-hub serve --port 6290
  action-hub daemon start
  action-hub connect
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // SEA embeddings selftest (SQ4 packaging round): with this env var set, the
  // (bundled) binary must load the vendored model through its SEA asset
  // extraction path and score a query, printing ONE machine-readable line.
  // The binary smoke test asserts this line — it is the proof that the
  // shipped executable serves real embeddings rather than the hashed
  // fallback.
  if (process.env["ACTION_HUB_EMBEDDINGS_SELFTEST"] === "1") {
    const { EmbeddingSemanticIndex } = await import("@action-hub/core");
    const index = new EmbeddingSemanticIndex();
    const t0 = Date.now();
    const ok = await index.load();
    let dims: number | null = null;
    let norm: number | null = null;
    if (ok) {
      const v = await index.embedQuery("pause the project in the staging environment");
      dims = v.length;
      norm = Math.sqrt([...v].reduce((sum, x) => sum + x * x, 0));
    }
    const so = ((process.report?.getReport() as { sharedObjects?: string[] } | undefined)?.sharedObjects ?? []) as string[];
    process.stdout.write(
      `${JSON.stringify({
        embeddingSelftest: {
          ok,
          backend: index.backend,
          dims,
          norm: norm === null ? null : Number(norm.toFixed(4)),
          loadMs: Date.now() - t0,
          nativeAddons: so.filter((entry: string) => entry.endsWith(".node")).length,
        },
      })}\n`,
    );
    process.exit(ok ? 0 : 1);

  // Hidden internal anchor/wrapper modes (process-anchor.ts): the anchored
  // process tree re-invokes THIS CLI instead of requiring an external
  // interpreter, so the standalone SEA binary stays zero-dependency. Must be
  // handled before any ordinary command parsing.
  if (args[0] === ANCHOR_MODE) {
    runAnchorProcess(args.slice(1));
    return;
  }
  if (args[0] === WRAPPER_MODE) {
    runWrapperProcess(args.slice(1));
    return;
  }

  // `harness --help` (or bare `harness`) shows the harness-specific help,
  // not the global help text.
  if (args[0] === "harness" &&
      (args.includes("--help") || args.includes("-h") || args.length === 1)) {
    await (await import("./commands/harness.js")).harnessCommand("help", {});
    return;
  }

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exitCode = 0;
    return;
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log(`action-hub ${VERSION}`);
    process.exitCode = 0;
    return;
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
        exitCode = await (await import("./commands/doctor.js")).doctorCommand({
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
        exitCode = await (await import("./commands/auth.js")).authCommand(action as import("./commands/auth.js").AuthAction, positional[1], {
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
        exitCode = await (await import("./commands/migrate.js")).migrateCommand({
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
        exitCode = await (await import("./commands/import.js")).importCommand({
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

        exitCode = await (await import("./commands/test-search.js")).testSearchCommand(query, {
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

        exitCode = await (await import("./commands/list.js")).listCommand({
          configPath,
          server: serverVal,
          kind: kindVal,
        });
        break;
      }

      case "bundle":
      case "bundles": {
        const loadVal = typeof parsedArgs["load"] === "string" ? parsedArgs["load"] : positional[0];
        if (parsedArgs["export"] === true) {
          // Present but valueless: the parser records a bare flag as `true`.
          console.error("Error: --export requires a bundle id (usage: action-hub bundle --export <id>)");
          exitCode = 1;
          break;
        }
        const exportVal = typeof parsedArgs["export"] === "string" ? parsedArgs["export"] : undefined;
        exitCode = await (await import("./commands/bundles.js")).bundlesCommand({
          configPath,
          load: loadVal,
          exportId: exportVal,
        });
        break;
      }

      case "start": {
        exitCode = await (await import("./commands/start.js")).startCommand({
          configPath,
        });
        break;
      }

      case "harness": {
        const target = positional[0] ?? "help";
        const modeArg =
          positional[1] === "export" || positional[1] === "install"
            ? positional[1]
            : undefined;
        if (
          parsedArgs["node"] !== undefined &&
          (typeof parsedArgs["node"] !== "string" || parsedArgs["node"].trim() === "")
        ) {
          // Valueless or empty --node would otherwise be silently dropped
          // (boolean true) or emit an empty command ("").
          console.error("Missing value for --node (usage: --node <absolute path to node>)");
          exitCode = 1;
          break;
        }
        exitCode = await (await import("./commands/harness.js")).harnessCommand(target, {
          mode: modeArg,
          write: Boolean(parsedArgs["write"]),
          json: Boolean(parsedArgs["json"]),
          configPath,
          node: typeof parsedArgs["node"] === "string" ? parsedArgs["node"] : undefined,
        });
        break;
      }

      case "serve": {
        const portVal = typeof parsedArgs["port"] === "string" ? Number.parseInt(parsedArgs["port"], 10) : undefined;
        exitCode = await (await import("./commands/serve.js")).serveCommand({
          configPath,
          port: Number.isFinite(portVal) ? portVal : undefined,
        });
        break;
      }

      case "connect": {
        const daemonDirVal = typeof parsedArgs["daemon-dir"] === "string" ? parsedArgs["daemon-dir"] : undefined;
        exitCode = await (await loadDaemon()).connectCommand({
          configPath,
          daemonDir: daemonDirVal,
        });
        break;
      }

      case "daemon": {
        const subcommand = positional[0];
        if (subcommand === "start") {
          const startTimeoutVal =
            typeof parsedArgs["start-timeout"] === "string"
              ? Number.parseInt(parsedArgs["start-timeout"], 10)
              : undefined;
          exitCode = await (await loadDaemon()).daemonStartCommand({
            configPath,
            ...(Number.isFinite(startTimeoutVal) ? { startTimeoutMs: startTimeoutVal } : {}),
          });
        } else if (subcommand === "status") {
          exitCode = await (await loadDaemon()).daemonStatusCommand({ configPath });
        } else if (subcommand === "stop") {
          exitCode = await (await loadDaemon()).daemonStopCommand({ configPath });
        } else {
          console.error("Usage: action-hub daemon <start|status|stop>");
          exitCode = 1;
        }
        break;
      }

      case "__daemon-run": {
        await (await loadDaemon()).runDaemonProcess();
        // Same lifecycle as `start`: the daemon resolves after its shutdown
        // handlers run, but without a forced exit the process could linger on
        // open handles (this child has no CLI caller to terminate it).
        await new Promise<void>((flushed) => process.stderr.write("", () => flushed()));
        process.exit(0);
        break;
      }

      default: {
        console.error(`Unknown command: "${command}". Run \`action-hub --help\` for available commands.`);
        exitCode = 1;
      }
    }

    // Set the exit code and return instead of calling process.exit() here:
    // process.exit() truncates pending stdout writes beyond ~64 KiB when stdout
    // is a pipe (the pipe buffer plus Node's internal buffer get discarded).
    // Commands that must force-close (serve's signal shutdown, the MCP server
    // runtime) do their own flush-then-exit internally.
    process.exitCode = exitCode;
  } catch (err) {
    console.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

void main();
