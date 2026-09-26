import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { context, propagation } from "@opentelemetry/api";
import { AsyncLocalStorage } from "node:async_hooks";
import { HUB_HTTP_TOKEN_ENV_VAR } from "./http-server.js";
import {
  applyNodeMemoryLimit,
  classifyDownstreamError,
  createHttpAuthBinding,
  type CallToolOptions,
  type JsonSchema,
  type McpClient,
  type McpClientFactory,
  type ServerConfig,
  type TokenStore,
  ToolError,
  connectWithDeadline,
} from "@action-hub/core";
import { McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const CLIENT_INFO = { name: "action-hub", version: "0.1.0" } as const;

export interface SdkClientFactoryOptions {
  /** Credential persistence. Defaults to the shared mode-0600 credential file. */
  tokenStore?: TokenStore;
  /** Diagnostics sink. stdout is the MCP channel, so this must not use it. */
  onWarning?: (message: string) => void;
}

/**
 * Adapts the official MCP SDK to the narrow `McpClient` interface the core
 * depends on. Keeping the surface this small is what lets the core stay
 * runtime-agnostic and lets tests inject in-memory fakes.
 */
export const createSdkClientFactory: (options?: SdkClientFactoryOptions) => McpClientFactory = (
  options = {},
) =>
  async (config: ServerConfig, factoryOptions?: { signal?: AbortSignal }) => {
    const activeHeaders = new AsyncLocalStorage<Record<string, string> | undefined>();
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    const transport = buildTransport(config, options, () => activeHeaders.getStore());

    // Positively track transport closure so callTool rejections can be
    // classified as transport-level (F16): tool-level failures must never
    // trip the breaker, a dead transport must.
    let transportClosed = false;
    const priorOnClose = transport.onclose?.bind(transport);
    transport.onclose = () => {
      transportClosed = true;
      priorOnClose?.();
    };

    await connectWithDeadline(client, transport, factoryOptions?.signal);

    return {
      async listTools(callOptions?: CallToolOptions) {
        return activeHeaders.run(callOptions?.headers, async () => {
          const response = await client.listTools();
          return response.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema as JsonSchema | undefined,
            annotations: tool.annotations,
          }));
        });
      },

      async callTool(name: string, args: Record<string, unknown>, callOptions?: CallToolOptions) {
        return activeHeaders.run(callOptions?.headers, async () => {
          const response = await client
            .callTool({ name, arguments: args })
            .catch((cause: unknown) => {
            // A coded McpError from a LIVE transport is a JSON-RPC error
            // response — tool-level, even when its code/message looks like a
            // connection error (a listening server can throw
            // McpError(-32000, "Connection closed") from application code).
            // But the same McpError arriving after transport.onclose is the
            // SDK surfacing a real closed transport, so it is classified
            // (and marked) with the non-spoofable transportClosed evidence.
            if (cause instanceof McpError && !transportClosed) throw cause;
            // Positively-identified transport failures are marked for the
            // circuit breaker; unknown/uncoded errors stay unmarked.
            throw classifyDownstreamError(cause, transportClosed);
          });
          if (response.isError === true) {
            // Tool-level failure from a live server: typed so the circuit
            // breaker can never confuse it with a dead transport.
            throw new ToolError(renderError(response.content));
          }
          return response.content;
        });
      },

      async close() {
        // client.close() on a half-connected SDK client is a no-op: the
        // TRANSPORT owns the spawned stdio child (or HTTP session), so close
        // it too — best-effort, independent of client.close()'s outcome (F26:
        // a tripped breaker must release the child, not leak it).
        await client.close().catch(() => {});
        await transport.close?.().catch(() => {});
      },
    } satisfies McpClient;
  };

function buildTransport(
  config: ServerConfig,
  options: SdkClientFactoryOptions,
  getHeaders?: () => Record<string, string> | undefined,
) {
  if (config.transport.type === "stdio") {
    const { command, args, env, cwd } = config.transport;
    const limited = applyNodeMemoryLimit(
      command,
      args ?? [],
      // The SDK does not inherit the parent environment, so a server that needs
      // PATH or HOME gets nothing unless we merge it in explicitly.
      { ...inheritableEnv(), ...(env ?? {}) },
      config.maxOldSpaceSizeMb,
    );
    return new StdioClientTransport({
      command: limited.command,
      args: limited.args,
      env: limited.env,
      cwd,
    });
  }

  const { url, headers } = config.transport;
  // Present only when the server declares an `auth` block; otherwise the
  // transport is built exactly as before and static headers keep working.
  const auth = createHttpAuthBinding({
    config,
    store: options.tokenStore,
    env: process.env,
    onWarning: (message: string) => options.onWarning?.(`${config.id}: ${message}`),
  });

  type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;
  const baseFetch: FetchLike = auth?.fetch ?? ((u, init) => fetch(u, init));
  const tracingFetch: FetchLike = async (url, init) => {
    const reqHeaders = new Headers(init?.headers);

    // Propagate active OpenTelemetry context over HTTP transport
    const traceCarrier: Record<string, string> = {};
    propagation.inject(context.active(), traceCarrier);
    for (const [key, value] of Object.entries(traceCarrier)) {
      if (!reqHeaders.has(key)) {
        reqHeaders.set(key, value);
      }
    }

    // Include any per-call headers
    const perCall = getHeaders?.();
    if (perCall) {
      for (const [key, value] of Object.entries(perCall)) {
        if (!reqHeaders.has(key)) {
          reqHeaders.set(key, value);
        }
      }
    }

    return baseFetch(url, { ...init, headers: reqHeaders });
  };

  return new StreamableHTTPClientTransport(new URL(url), {
    requestInit: headers ? { headers } : undefined,
    fetch: tracingFetch,
  });
}

export function inheritableEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Defense in depth: the hub's inbound bearer credential must never reach
    // a downstream MCP server subprocess (mirrors the scrub in http-server.ts).
    if (key === HUB_HTTP_TOKEN_ENV_VAR) continue;
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function renderError(content: unknown): string {
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (isTextPart(part) ? part.text : ""))
      .filter((part) => part.length > 0)
      .join("\n");
    if (text.length > 0) return text;
  }
  return "Downstream tool reported an error";
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "text" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}
