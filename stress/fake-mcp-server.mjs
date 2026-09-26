#!/usr/bin/env node
/**
 * stress/fake-mcp-server.mjs — builder-8 (stress packet S2, file owner).
 *
 * Contract-shaped fake MCP server (see stress/CONTRACT.md): serves a tool
 * manifest over stdio (default) or Streamable HTTP (--transport http --port N),
 * honoring per-tool behavior and chaos flags.
 *
 * Usage:
 *   node stress/fake-mcp-server.mjs --manifest <path> [--transport stdio|http]
 *        [--port N] [--chaos 'crash-after=N,hang-rate=R,slow-start-ms=N,huge-bytes=N,stderr-secret=VALUE']
 *
 * Manifest (per stress/CONTRACT.md):
 *   { "serverId": "acme-crm",
 *     "tools": [{ "name": "list_contacts", "description": "...",
 *                 "inputSchema": { JSON Schema },
 *                 "annotations": { "readOnlyHint": true },
 *                 "behavior": { "latencyMs": 5, "errorRate": 0, "responseBytes": 512 } }] }
 *
 * Chaos keys (comma-separated key=value after --chaos):
 *   crash-after=N     counts tools/call requests ONLY (initialize,
 *                     tools/list and pings never count). Calls 1..N are
 *                     accepted and served; calls above N are refused
 *                     immediately with isError and never count. JSON-RPC
 *                     ids are scoped per connection, so acceptance and
 *                     delivery are tracked per transport instance plus id.
 *                     Exit once all N accepted calls have settled, each as
 *                     finished (fully delivered: stdio write callback /
 *                     HTTP ServerResponse 'finish') or aborted (client
 *                     went away mid-response; never counted as
 *                     completed). The log reports completed=K aborted=M
 *                     exactly once.
 *   hang-rate=R       per tools/call draw: never respond to that call
 *   seed=N            deterministic PRNG seed (mulberry32) for hang-rate and
 *                     errorRate draws; also accepted as --seed or CHAOS_SEED;
 *                     default 1. The seed is logged at startup.
 *   slow-start-ms=N   delay before the server serves its first request
 *   huge-bytes=N      pad every successful tools/call result to ~N bytes
 *   stderr-secret=V   print "chaos: secret=V" to stderr once at startup
 *
 * Deterministic given (manifest, seed): all probabilistic chaos draws use a seeded PRNG.
 * Requires @modelcontextprotocol/sdk (resolved from the repo's node_modules).
 */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  PingRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (typeof next === "string" && !next.startsWith("--")) {
      out[a.slice(2)] = next;
      i++;
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const manifestPath = typeof args["manifest"] === "string" ? args["manifest"] : "";
const transportKind = typeof args["transport"] === "string" ? args["transport"] : "stdio";
const httpPortArg = typeof args["port"] === "string" ? Number.parseInt(args["port"], 10) : NaN;
const httpPort = httpPortArg;

if (!manifestPath || (transportKind !== "stdio" && transportKind !== "http")) {
  process.stderr.write("usage: fake-mcp-server.mjs --manifest <path> [--transport stdio|http] [--port N] [--chaos FLAGS]\n");
  process.exit(2);
}
if (transportKind === "http" && !Number.isInteger(httpPort)) {
  process.stderr.write("--transport http requires --port N\n");
  process.exit(2);
}

// chaos flags: comma-separated key=value per CONTRACT.md
const chaos = new Map();
for (const kv of String(args["chaos"] ?? "").split(",").filter(Boolean)) {
  const eq = kv.indexOf("=");
  if (eq > 0) chaos.set(kv.slice(0, eq), kv.slice(eq + 1));
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const serverId = String(manifest.serverId ?? "fake-mcp");

const crashAfter = chaos.has("crash-after") ? Number(chaos.get("crash-after")) : undefined;
const hangRate = Number(chaos.get("hang-rate") ?? 0);
const slowStartMs = Number(chaos.get("slow-start-ms") ?? 0);
const hugeBytes = Number(chaos.get("huge-bytes") ?? 0);
const stderrSecret = chaos.get("stderr-secret");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- chaos bookkeeping -------------------------------------------------------

// --- crash-after bookkeeping (tools/call only; see header) -------------------

// Accepted calls are registered per CONNECTION (each transport instance
// gets its own conn object); JSON-RPC ids are client-scoped, so a global
// id map would let two concurrent clients collide. Settled calls are
// counted globally: finished = fully delivered, aborted = client went
// away mid-response (never counted as completed).
let acceptedCalls = 0;
let finishedCalls = 0;
let abortedCalls = 0;
let crashDone = false;

function crashLog(reason) {
  if (crashDone) return;
  crashDone = true;
  process.stderr.write(`chaos: crash-after=${crashAfter} triggered: completed=${finishedCalls} aborted=${abortedCalls} (${reason})\n`);
  process.exit(1);
}

/**
 * Called from the tools/call handler with the connection state shared with
 * the transport wrapper. Returns false when this call must be refused
 * (limit reached); refused calls are not registered and their isError
 * replies never count. Accepted calls are recorded in the connection's
 * accepted-id set so the transport send hook can tie delivery to the
 * exact response of THIS client.
 */
function beginToolCall(extra, conn) {
  if (crashAfter === undefined) return true;
  if (acceptedCalls >= crashAfter) return false;
  acceptedCalls += 1;
  conn.acceptedIds.add(extra.requestId);
  return true;
}

function refusalResult() {
  return {
    content: [{ type: "text", text: "chaos: crash-after limit reached; refusing further requests" }],
    isError: true,
  };
}

/**
 * Transport wrapper tying crash delivery to the Nth accepted tools/call
 * response ONLY. initialize/tools/list/ping responses are not in callState
 * and never count. stdio: exit after the write resolves (drain). HTTP:
 * send() resolving does not mean the ServerResponse flushed, so arm a
 * 'finish' hook on that request's own res (captured via handleRequest),
 * never a global flag. Every SDK-assigned handler passes through.
 */
function withCrashCounting(inner, conn, { http = false } = {}) {
  return new Proxy(inner, {
    get(target, prop, recv) {
      if (prop === "send") {
        return async (msg) => {
          const result = await target.send(msg);
          if (!http && crashAfter !== undefined && msg && typeof msg === "object" && !("method" in msg)) {
            // stdio: the write callback means the chunk is in the pipe
            // buffer, which survives process exit — settlement signal.
            if (conn.acceptedIds.has(msg.id)) {
              conn.acceptedIds.delete(msg.id);
              finishedCalls += 1;
              if (finishedCalls + abortedCalls >= crashAfter) crashLog("write-drained");
            }
          }
          return result;
        };
      }
      if (prop === "handleRequest" && http) {
        // Stateless HTTP: this res serves at most one request. finish/close
        // listeners are armed BEFORE the handler runs, so a client that
        // aborts mid-latency or mid-body is always settled (an accepted
        // call aborts; a refused/unrelated request settles nothing). A
        // handleRequest rejection settles as aborted too. settled-once
        // guards prevent double counting.
        return async (req, res, ...rest) => {
          let settled = false;
          const settle = (kind, reason) => {
            if (settled) return;
            settled = true;
            if (conn.acceptedIds.size === 0) return; // nothing accepted on this res
            for (const id of conn.acceptedIds) conn.acceptedIds.delete(id);
            if (kind === "finished") finishedCalls += 1;
            else abortedCalls += 1;
            if (finishedCalls + abortedCalls >= crashAfter) crashLog(reason);
          };
          res.once("finish", () => settle("finished", "finish"));
          res.once("close", () => {
            if (!res.writableFinished) settle("aborted", "client-abort");
          });
          try {
            return await target.handleRequest(req, res, ...rest);
          } catch (cause) {
            settle("aborted", "send-rejected");
            throw cause;
          }
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// Deterministic PRNG (mulberry32): seeded from --seed, CHAOS_SEED, or
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED_RAW = chaos.get("seed") ?? args["seed"] ?? process.env.CHAOS_SEED ?? "1";
const SEED = Number(SEED_RAW);
if (!Number.isFinite(SEED)) {
  process.stderr.write(`chaos: invalid seed ${JSON.stringify(SEED_RAW)}; using 1\n`);
}
const SEED_VALUE = Number.isFinite(SEED) ? SEED : 1;
const rand = mulberry32(SEED_VALUE);

function toolBehavior(name) {
  const tool = manifest.tools.find((t) => t.name === name);
  return tool?.behavior ?? {};
}

function hangForever() {
  return new Promise(() => {});
}

function buildTools() {
  return manifest.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    ...(t.annotations ? { annotations: t.annotations } : {}),
  }));
}

function registerHandlers(server, conn) {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: buildTools() };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (!beginToolCall(extra, conn)) return refusalResult();
    const tool = manifest.tools.find((t) => t.name === request.params.name);
    // Unknown tool names are rejected with an isError result, consistent
    // with real servers (a plain ok:true would hide router defects).
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${String(request.params.name)}` }],
        isError: true,
      };
    }
    const behavior = tool.behavior ?? {};
    // Hang-rate draws only on tools/call, per contract: initialize and
    if (hangRate > 0 && rand() < hangRate) {
      return hangForever();
    }
    const latencyMs = Number(behavior?.latencyMs ?? 0);
    if (latencyMs > 0) await sleep(latencyMs);
    const errorRate = Number(behavior?.errorRate ?? 0);
    if (errorRate > 0 && rand() < errorRate) {
      return {
        content: [{ type: "text", text: String(behavior.errorText ?? "injected failure") }],
        isError: true,
      };
    }
    const bytes = hugeBytes || Number(behavior.responseBytes ?? 0);
    const filler = bytes > 0 ? "x".repeat(bytes) : undefined;
    const payload = { ok: true, tool: request.params.name, ...(bytes > 0 ? { filler } : {}) };
    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
  });

  server.setRequestHandler(PingRequestSchema, async () => {
    return {};
  });
}

// --- transports ----------------------------------------------------------------

async function runStdio() {
  const conn = { acceptedIds: new Set() };
  const server = new Server({ name: serverId, version: "0.0.0" }, { capabilities: { tools: {} } });
  registerHandlers(server, conn);
  const transport = withCrashCounting(new StdioServerTransport(), conn);
  await server.connect(transport);
  // Exit when the client closes the session so spawnSync callers get a
  // clean exit code instead of an orphan; serve until then.
  transport.onclose = () => process.exit(0);
  await new Promise(() => {}); // serve until killed or crash-after trips
}

function runHttp() {
  // Stateless Streamable HTTP: a fresh transport + server per POST request
  // (SDK stateless pattern). GET/DELETE are rejected with 405.
  const httpServer = createServer(async (req, res) => {
    // Endpoint discipline: only /mcp answers; anything else 404s visibly so
    // misconfigured clients fail loudly instead of probing a lenient server.
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `unknown path ${req.url} (use /mcp)` }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let parsed;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400).end();
      return;
    }

    // Stateless Streamable HTTP: a fresh transport + server per POST request
    // (SDK stateless pattern). GET/DELETE are rejected with 405.
    const conn = { acceptedIds: new Set() };
    const transport = withCrashCounting(new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }), conn, { http: true });
    res.on("close", () => {
      void transport.close().catch(() => {});
    });
    const server = new Server({ name: serverId, version: "0.0.0" }, { capabilities: { tools: {} } });
    registerHandlers(server, conn);
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500).end();
      }
      process.stderr.write(`fake-mcp: request failed: ${String(err)}\n`);
    }
  });

  httpServer.listen(httpPort, "127.0.0.1", () => {
    const actualPort = httpServer.address()?.port ?? httpPort;
    process.stderr.write(`chaos: fake ${serverId} listening on http://127.0.0.1:${actualPort}/mcp\n`);
  });
  const shutdown = () => {
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return new Promise(() => {}); // serve until killed
}

// --- startup -------------------------------------------------------------------

if (stderrSecret !== undefined) {
  process.stderr.write(`chaos: secret=${stderrSecret}\n`);
}
// Determinism: the seed drives every probabilistic draw (hang-rate,
// errorRate). Recorded here so a failing run can be replayed byte-for-byte.
process.stderr.write(`chaos: seed=${SEED_VALUE}\n`);
if (slowStartMs > 0) await sleep(slowStartMs);

if (transportKind === "http") {
  void runHttp();
} else {
  void runStdio();
}
