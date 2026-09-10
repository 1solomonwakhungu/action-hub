import { runServer } from "@action-hub/copilot-mcp";
import { resolvePath } from "../config-loader.js";

export interface StartOptions {
  configPath?: string;
  port?: number;
}

/**
 * Runs the Action Hub meta-MCP server on stdio.
 *
 * The server runs in-process rather than as a spawned child. This is what makes
 * the command work identically from `node dist/index.js` and from the bundled
 * standalone binary, where `process.execPath` is the binary itself and there is
 * no separate `node` to spawn or server `dist/` on disk to locate.
 *
 * stdout is the JSON-RPC channel, so every diagnostic here goes to stderr to
 * keep the protocol stream clean.
 */
export async function startCommand(options: StartOptions = {}): Promise<number> {
  process.stderr.write("Starting Action Hub MCP server (stdio)...\n");

  if (options.configPath) {
    process.env["ACTION_HUB_CONFIG"] = resolvePath(options.configPath);
  }

  await runServer();
  return 0;
}
