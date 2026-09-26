import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { classifyDownstreamError, ToolError } from "@action-hub/core";
import { context, propagation } from "@opentelemetry/api";
import { AsyncLocalStorage } from "node:async_hooks";
import { StringDecoder } from "node:string_decoder";
import { HUB_HTTP_TOKEN_ENV_VAR } from "@action-hub/copilot-mcp";
import {
  applyNodeMemoryLimit,
  createHttpAuthBinding,
  isAuthorizationRequired,
  sanitizeErrorForServer,
  type CallToolOptions,
  type JsonSchema,
  type McpClient,
  type McpClientFactory,
  type ServerConfig,
  type TokenStore,
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
    const activeHeaders = new AsyncLocalStorage<Record<string, string> | undefined>();
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    const transport = buildTransport(config, options, () => activeHeaders.getStore());

    if (config.transport.type === "stdio") {
      const stdioTransport = transport as StdioClientTransport;
      attachSanitizedStderr(stdioTransport, config, options);
    }

    // Positively track transport closure so callTool rejections can be
    // classified as transport-level (F16): a dead transport is exactly where
    // the SDK surfaces plain, uncoded errors that must trip the breaker,
    // while tool-level failures must not.
    let transportClosed = false;
    const priorOnClose = transport.onclose?.bind(transport);
    transport.onclose = () => {
      transportClosed = true;
      priorOnClose?.();
    };

    try {
      await client.connect(transport);
    } catch (cause) {
      throw describeConnectFailure(config, cause);
    }

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
            // The SDK signals a closed transport as McpError -32000
            // "Connection closed" — that code is itself the positive
            // transport-level signal.
            if (
              cause instanceof McpError &&
              (cause as McpError).code === -32000 &&
              /connection closed/i.test((cause as McpError).message)
            ) {
              throw classifyDownstreamError(cause, true);
            }
            // Any other coded McpError is a JSON-RPC error response from a
            // live server: tool-level, never counts against the breaker.
            if (cause instanceof McpError) throw cause;
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
        await client.close();
      },
    } satisfies McpClient;
  };
};

/**
 * Buffer cap for a child stderr line without newlines. Beyond this the
 * partial line is sanitized and flushed as-is rather than buffering
 * unboundedly (fail closed: an over-long line is more likely to carry
 * secrets than to be meaningful output).
 */
const MAX_PENDING_STDERR_BYTES = 8 * 1024;

/**
 * Pipe a stdio server's stderr and re-emit it sanitized.
 *
 * Sanitization is line-buffered, not per-chunk: a secret the child writes in
 * pieces (or that Node splits across chunk boundaries) must be assembled
 * before exact-value replacement runs. UTF-8 sequences split across chunks
 * are decoded correctly via StringDecoder; a final partial line is flushed
 * when the stream ends or closes. The listener stays attached for the
 * transport's lifetime so the SDK's PassThrough is always drained.
 */
function attachSanitizedStderr(
  transport: StdioClientTransport,
  config: ServerConfig,
  options: SdkClientFactoryOptions,
): void {
  const stream = transport.stderr;
  if (!stream) return;

  const emit = (safe: string): void => {
    if (options.onWarning) options.onWarning(`${config.id}: ${safe.trimEnd()}`);
    else process.stderr.write(safe);
  };

  const decoder = new StringDecoder("utf8");
  let pending = "";
  let flushed = false;
  /** True while we are discarding an over-long line (fail closed). */
  let discarding = false;

  const flush = (): void => {
    if (flushed) return;
    flushed = true;
    const tail = discarding ? "" : pending + decoder.end();
    pending = "";
    if (tail.length > 0) emit(sanitizeErrorForServer(config, tail));
  };

  stream.on("data", (chunk: Buffer | string) => {
    pending += decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);

    if (discarding) {
      // An over-long line is being discarded wholesale: a configured secret
      // crossing the cap boundary must never be emitted in fragments.
      const resume = pending.indexOf("\n");
      if (resume >= 0) {
        pending = pending.slice(resume + 1);
        discarding = false;
      } else {
        pending = "";
        return;
      }
    }

    let newlineIndex: number;
    while ((newlineIndex = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newlineIndex);
      pending = pending.slice(newlineIndex + 1);
      emit(`${sanitizeErrorForServer(config, line)}\n`);
    }

    // Cap is measured in bytes, not JS characters. Exceeding it fails
    // closed: the buffered logical line is NOT emitted (an unsanitized
    // prefix could carry most of a configured secret); only a fixed marker
    // is emitted and the remainder of the line is discarded through the
    // next newline.
    if (Buffer.byteLength(pending, "utf8") > MAX_PENDING_STDERR_BYTES) {
      emit(`[stderr line truncated: ${Buffer.byteLength(pending, "utf8")} bytes discarded]\n`);
      pending = "";
      discarding = true;
    }
  });
  stream.on("end", flush);
  stream.on("close", flush);
  stream.on("error", flush);
}

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
      // Child stderr must never reach the parent's stderr verbatim: servers
      // echo their own configuration (tokens, URLs) in crash output. Piped
      // stderr is sanitized per-server before it is re-emitted.
      stderr: "pipe",
    });
  }

  const { url, headers } = config.transport;
  const auth = createHttpAuthBinding({
    config,
    store: options.tokenStore,
    env: options.env ?? process.env,
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

    // Include any per-call headers (e.g. from callTool options)
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
    // Static headers still apply; the OAuth header is set last and wins, so a
    // stale hand-written `Authorization` cannot shadow a live token.
    requestInit: headers ? { headers } : undefined,
    fetch: tracingFetch,
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
