import { startHttpServer, type HttpServerHandle } from "@action-hub/copilot-mcp";
import { resolvePath } from "../config-loader.js";

export interface ServeOptions {
  configPath?: string;
  port?: number;
}

/**
 * Runs the Action Hub meta-MCP server over Streamable HTTP (the modern
 * successor to the deprecated SSE transport) so HTTP-based agents and
 * harnesses can connect without stdio process spawning.
 *
 * Binds to 127.0.0.1 and requires a bearer token on every request except
 * /health. When ACTION_HUB_HTTP_TOKEN is unset, a token is generated and
 * printed to stderr.
 */
export async function serveCommand(options: ServeOptions = {}): Promise<number> {
  process.stderr.write("Starting Action Hub MCP server (streamable HTTP)...\n");

  if (options.configPath) {
    process.env["ACTION_HUB_CONFIG"] = resolvePath(options.configPath);
  }

  let handle: HttpServerHandle;
  try {
    handle = await startHttpServer({ port: options.port });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`action-hub serve: failed to start: ${message}\n`);
    return 1;
  }

  process.stderr.write(
    `action-hub serve: listening on http://${handle.host}:${handle.port}/mcp ` +
      `(bearer token: ${handle.token === process.env["ACTION_HUB_HTTP_TOKEN"] ? "from ACTION_HUB_HTTP_TOKEN" : "generated (printed above)"})\n`,
  );

  // Serve until SIGINT/SIGTERM; tear the runtime down before exiting so
  // downstream MCP connections close cleanly instead of dying mid-request.
  let exitCode = 0;
  const shutdown = (signal: string) => {
    process.stderr.write(`action-hub serve: ${signal} received, shutting down...\n`);
    void handle
      .close()
      .catch((cause: unknown) => {
        process.stderr.write(
          `action-hub serve: shutdown error: ${cause instanceof Error ? cause.message : String(cause)}\n`,
        );
        exitCode = 1;
      })
      .finally(() => process.exit(exitCode));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Resolves only via the shutdown path above; keeps the event loop alive.
  await new Promise<never>(() => undefined);
  return 0;
}
