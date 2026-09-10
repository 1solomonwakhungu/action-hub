import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { applyNodeMemoryLimit, createHttpAuthBinding, isAuthorizationRequired } from "@action-hub/core";
import type {
  JsonSchema,
  McpClient,
  McpClientFactory,
  ServerConfig,
  TokenStore,
} from "@action-hub/core";

const CLIENT_INFO = { name: "action-hub-cli", version: "0.1.0" } as const;

export interface SdkClientFactoryOptions {
  /**
   * Where OAuth credentials live. Defaults to the shared mode-0600 credential
   * file; an embedding host can pass a keychain-backed store instead.
   */
  tokenStore?: TokenStore;
  /** Environment used to resolve `clientIdEnv` / `clientSecretEnv`. */
  env?: NodeJS.ProcessEnv;
  /** Diagnostics sink. stdout is the MCP channel, so this must not use it. */
  onWarning?: (message: string) => void;
}

/**
 * Adapts the official MCP SDK to the narrow `McpClient` interface the core
 * depends on.
 *
 * The OAuth path is additive: a server with no `auth` block behaves exactly as
 * before, static `Authorization` headers included. When `auth` is present, the
 * transport is handed a fetch that acquires a token before the first byte goes
 * out and refreshes on expiry or 401 — so a long-lived hub keeps working past
 * the access token's lifetime without anyone re-pasting a credential.
 */
export const createSdkClientFactory: (options?: SdkClientFactoryOptions) => McpClientFactory = (
  options = {},
) => {
  return async (config: ServerConfig) => {
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    const transport = buildTransport(config, options);

    try {
      await client.connect(transport);
    } catch (cause) {
      throw describeConnectFailure(config, cause);
    }

    return {
      async listTools() {
        const response = await client.listTools();
        return response.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as JsonSchema | undefined,
        }));
      },

      async callTool(name: string, args: Record<string, unknown>) {
        const response = await client.callTool({ name, arguments: args });
        if (response.isError === true) {
          throw new Error(renderError(response.content));
        }
        return response.content;
      },

      async close() {
        await client.close();
      },
    } satisfies McpClient;
  };
};

function buildTransport(config: ServerConfig, options: SdkClientFactoryOptions) {
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
  const auth = createHttpAuthBinding({
    config,
    store: options.tokenStore,
    env: options.env ?? process.env,
    onWarning: (message) => options.onWarning?.(`${config.id}: ${message}`),
  });

  return new StreamableHTTPClientTransport(new URL(url), {
    // Static headers still apply; the OAuth header is set last and wins, so a
    // stale hand-written `Authorization` cannot shadow a live token.
    requestInit: headers ? { headers } : undefined,
    fetch: auth?.fetch,
  });
}

/**
 * Turns an authorization failure into an instruction instead of a stack trace.
 *
 * Connection errors surface in `doctor` output and in the capability manager,
 * where "re-authorize this server" is actionable and "401" is not.
 */
function describeConnectFailure(config: ServerConfig, cause: unknown): Error {
  if (isAuthorizationRequired(cause)) {
    return new Error(`${cause.message}. Run \`action-hub auth login ${config.id}\` to authorize.`, {
      cause,
    });
  }
  return cause instanceof Error ? cause : new Error(String(cause));
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
