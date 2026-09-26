import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
<<<<<<< Updated upstream
import { context, propagation } from "@opentelemetry/api";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  applyNodeMemoryLimit,
  createHttpAuthBinding,
  type CallToolOptions,
  type JsonSchema,
  type McpClient,
  type McpClientFactory,
  type ServerConfig,
  type TokenStore,
} from "@action-hub/core";

const CLIENT_INFO = { name: "action-hub", version: "0.1.0" } as const;

export interface SdkClientFactoryOptions {
  /** Credential persistence. Defaults to the shared mode-0600 credential file. */
  tokenStore?: TokenStore;
  /** Diagnostics sink. stdout is the MCP channel, so this must not use it. */
  onWarning?: (message: string) => void;
}
=======
import type { JsonSchema, McpClient, McpClientFactory, ServerConfig } from "@action-hub/core";
import { OAuthManager } from "@action-hub/core";

const CLIENT_INFO = { name: "action-hub", version: "0.1.0" } as const;

/** Shared oauth manager for refreshing tokens on HTTP transports */
const defaultOAuthManager = new OAuthManager();
>>>>>>> Stashed changes

/**
 * Adapts the official MCP SDK to the narrow `McpClient` interface the core
 * depends on. Keeping the surface this small is what lets the core stay
 * runtime-agnostic and lets tests inject in-memory fakes.
 */
<<<<<<< Updated upstream
export const createSdkClientFactory: (options?: SdkClientFactoryOptions) => McpClientFactory = (
  options = {},
) =>
  async (config: ServerConfig) => {
    const activeHeaders = new AsyncLocalStorage<Record<string, string> | undefined>();
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    const transport = buildTransport(config, options, () => activeHeaders.getStore());
=======
export const createSdkClientFactory: (oauth?: OAuthManager) => McpClientFactory = (oauth = defaultOAuthManager) => async (config: ServerConfig) => {
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  const transport = await buildTransport(config, oauth);
>>>>>>> Stashed changes

    await client.connect(transport);

<<<<<<< Updated upstream
    return {
      async listTools(callOptions?: CallToolOptions) {
        return activeHeaders.run(callOptions?.headers, async () => {
          const response = await client.listTools();
          return response.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema as JsonSchema | undefined,
          }));
        });
      },
=======
  return {
    async listTools() {
      const response = await client.listTools();
      return response.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as JsonSchema | undefined,
        annotations: (tool as any).annotations,
      }));
    },
>>>>>>> Stashed changes

      async callTool(name: string, args: Record<string, unknown>, callOptions?: CallToolOptions) {
        return activeHeaders.run(callOptions?.headers, async () => {
          const response = await client.callTool({ name, arguments: args });
          if (response.isError === true) {
            throw new Error(renderError(response.content));
          }
          return response.content;
        });
      },

      async close() {
        await client.close();
      },
    } satisfies McpClient;
  };

<<<<<<< Updated upstream
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
=======
async function buildTransport(config: ServerConfig, oauth: OAuthManager) {
  if (config.transport.type === "stdio") {
    const { command, args, env, cwd, maxOldSpaceSize } = config.transport;
    const finalArgs = [...(args ?? [])];
    const finalEnv = { ...inheritableEnv(), ...(env ?? {}) };

    // Automatic memory limit enforcement (e.g. node subprocesses)
    if (maxOldSpaceSize && maxOldSpaceSize > 0) {
      if (command.endsWith("node") || command === "npx" || command === "node") {
        finalArgs.unshift(`--max-old-space-size=${maxOldSpaceSize}`);
      } else {
        // Enforce via NODE_OPTIONS for child node processes
        const existingNodeOptions = finalEnv["NODE_OPTIONS"] ?? "";
        if (!existingNodeOptions.includes("--max-old-space-size")) {
          finalEnv["NODE_OPTIONS"] = `${existingNodeOptions} --max-old-space-size=${maxOldSpaceSize}`.trim();
        }
      }
    }

    return new StdioClientTransport({
      command,
      args: finalArgs,
      // The SDK does not inherit the parent environment, so a server that needs
      // PATH or HOME gets nothing unless we merge it in explicitly.
      env: finalEnv,
>>>>>>> Stashed changes
      cwd,
    });
  }

<<<<<<< Updated upstream
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
=======
  const { url, headers, oauth: oauthConfig } = config.transport;
  const mergedHeaders: Record<string, string> = { ...(headers ?? {}) };

  // OAuth 2.0 token rotation support
  if (oauthConfig) {
    oauth.register(config.id, oauthConfig);
    const token = await oauth.getValidToken(config.id);
    if (token) {
      mergedHeaders["Authorization"] = `Bearer ${token}`;
    }
  }

  return new StreamableHTTPClientTransport(new URL(url), {
    requestInit: Object.keys(mergedHeaders).length > 0 ? { headers: mergedHeaders } : undefined,
>>>>>>> Stashed changes
  });
}

function inheritableEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
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
