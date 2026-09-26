import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createHubRuntime, createMcpServer, type HubRuntime } from "./index.js";

/**
 * Streamable HTTP MCP server mode.
 *
 * Serves the Action Hub catalog over the MCP Streamable HTTP transport so
 * web-based agents, microservices, or local harnesses can connect without
 * stdio process spawning:
 *
 *   POST /mcp   — JSON-RPC messages (stateless mode; no session tracking)
 *   GET  /mcp   — rejected with 405 (no server-initiated SSE stream)
 *   GET  /health — unauthenticated liveness probe
 *
 * Security model:
 *   - Binds to 127.0.0.1 by default; remote exposure is an explicit choice.
 *   - Every path except /health requires `Authorization: Bearer <token>`.
 *     The token comes from `ACTION_HUB_HTTP_TOKEN`, or is generated and
 *     printed to stderr when unset.
 */

const MCP_PATH = "/mcp";
const HEALTH_PATH = "/health";

/**
 * The hub's inbound credential. Deleted from this process's environment right
 * after it is read, and stripped again in the stdio client factories, so a
 * downstream MCP server subprocess can never inherit the token that grants
 * access to the hub itself.
 */
export const HUB_HTTP_TOKEN_ENV_VAR = "ACTION_HUB_HTTP_TOKEN";

/** Default cap on a single authenticated request body. */
export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Where the active bearer token came from. */
export type HttpTokenSource = "env" | "explicit" | "generated";

/**
 * Resolves the bearer token BEFORE the environment is scrubbed, so the
 * source can be reported accurately later (the env var is gone by the time
 * callers would otherwise try to infer it).
 */
export function resolveHttpToken(options: HttpServerOptions): { token: string; source: HttpTokenSource } {
  if (options.token) return { token: options.token, source: "explicit" };
  const fromEnv = process.env[HUB_HTTP_TOKEN_ENV_VAR];
  if (fromEnv) return { token: fromEnv, source: "env" };
  return { token: randomBytes(24).toString("hex"), source: "generated" };
}

export interface HttpServerOptions {
  /** Reject request bodies larger than this (default 4 MiB) with 413. */
  maxBodyBytes?: number;

  /** Port to bind. Default 6290; pass 0 for an ephemeral port. */
  port?: number;
  /** Bind address. Default 127.0.0.1 — loopback only. */
  host?: string;
  /** Bearer token. Default: $ACTION_HUB_HTTP_TOKEN, else generated + printed to stderr. */
  token?: string;
}

export interface HttpServerHandle {
  /** Bound port (useful when 0 was passed and an ephemeral port was chosen). */
  port: number;
  /** Address the server is bound to. */
  host: string;
  /** The active bearer token (so callers can discover the generated one). */
  token: string;
  /** Where the token came from — never derived after the env scrub. */
  tokenSource: HttpTokenSource;
  /** The hub runtime behind this server (introspection and tests). */
  runtime: HubRuntime;
  /** Stops the HTTP listener and tears down the hub runtime. */
  close(): Promise<void>;
}

export function readBoundedBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    req.on("data", (chunk: Buffer) => {
      if (overflow) return; // already over the cap; discard the remainder
      size += chunk.length;
      if (size > maxBytes) {
        overflow = true;
        chunks.length = 0;
        // Stop buffering and drop the rest of the stream instead of growing
        // process memory without bound.
        req.resume();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim() || undefined;
}

/** Constant-time comparison: compares SHA-256 digests so length and content both leak nothing. */
function tokensEqual(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Starts a Streamable HTTP MCP server backed by a fresh hub runtime.
 *
 * Resolves once the listener is bound; keeps serving until `close()` or an
 * externally-managed shutdown.
 */
export async function startHttpServer(options: HttpServerOptions = {}): Promise<HttpServerHandle> {
  const port = options.port ?? 6290;
  const host = options.host ?? "127.0.0.1";

  const { token, source: tokenSource } = resolveHttpToken(options);
  if (tokenSource === "generated") {
    process.stderr.write(`action-hub serve: generated bearer token: ${token}\n`);
  }

  // The token has been read; scrub it from this process's environment BEFORE
  // the hub runtime spawns any downstream stdio MCP server, so no child ever
  // inherits the credential that authorizes access to this hub.
  delete process.env[HUB_HTTP_TOKEN_ENV_VAR];

  const runtime: HubRuntime = await createHubRuntime();

  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  // Stateless mode: each POST gets its own McpServer + transport pair so
  // concurrent requests cannot collide JSON-RPC ids or misroute responses.
  // They all share the single hub runtime, so the catalog and connections
  // are built once.

  const httpServer = http.createServer((req, res) => {
    void route(req, res).catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (!res.headersSent) sendJson(res, 500, { error: message });
      else res.end();
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Liveness stays unauthenticated so probes do not need the token.
    if (req.method === "GET" && url.pathname === HEALTH_PATH) {
      sendJson(res, 200, { status: "ok", service: "action-hub" });
      return;
    }

    const presented = bearerToken(req);
    if (!presented || !tokensEqual(presented, token)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    if (url.pathname !== MCP_PATH) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    if (req.method === "POST") {
      const raw = await readBoundedBody(req, maxBodyBytes);
      if (raw === null) {
        sendJson(res, 413, { error: `Request body exceeds the ${maxBodyBytes}-byte limit` });
        return;
      }
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" });
        return;
      }
      // Fresh server + transport per request; stateless mode keeps no session
      // state, so nothing needs to outlive the response.
      const requestServer = createMcpServer(runtime);
      const requestTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      requestTransport.onclose = () => void requestServer.close().catch(() => undefined);
      await requestServer.connect(requestTransport);
      try {
        await requestTransport.handleRequest(req, res, parsedBody);
        // F23 rework: stateless HTTP clients may skip the initialize
        // handshake, so the deferred refresh is also triggered after the
        // first request — but only AFTER the response has flushed and off
        // this callback's turn (setImmediate), so the authoritative re-index
        // can never extend the client-observed response latency even if its
        // work is synchronous. Memoised in the runtime, so repeated
        // stateless requests cannot duplicate it.
        const trigger = () => setImmediate(() => runtime.startRefresh());
        if (res.writableFinished) trigger();
        else res.once("finish", trigger);
      } finally {
        await requestTransport.close().catch(() => undefined);
      }
      return;
    }

    // GET (server-initiated SSE stream) and DELETE (session teardown) have no
    // meaning in stateless mode.
    sendJson(res, 405, { error: `Method ${req.method} not allowed; use POST /mcp` });
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;

  async function close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((cause) => (cause ? reject(cause) : resolve()));
    });
    await runtime.close();
  }

  return { runtime, port: boundPort, host, token, tokenSource, close };
}
