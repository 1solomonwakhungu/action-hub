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
 *   crash-after=N     after the Nth JSON-RPC request is served (reply
 *                     delivered), print a stderr note and exit(1)
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

let requestsReceived = 0;
let responsesDelivered = 0;
let crashArmed = false;

/**
 * Count a received JSON-RPC request. Returns true when this request reached
 * the crash-after limit; callers must refuse any further work beyond N.
 * Crash delivery is handled by the transport send hook below, so the Nth
 * response is fully written before the process exits.
 */
function serveRequest() {
  if (crashArmed) return false;
  requestsReceived += 1;
  if (crashAfter !== undefined && requestsReceived >= crashAfter) {
    crashArmed = true;
  }
  return true;
}

function refusalResult() {
  return {
    content: [{ type: "text", text: "chaos: crash-after limit reached; refusing further requests" }],
    isError: true,
  };
}

function maybeCrashAfterDelivery() {
  if (crashAfter !== undefined && responsesDelivered >= crashAfter) {
    process.stderr.write(`chaos: crash-after=${crashAfter} triggered after ${responsesDelivered} completed responses\n`);
    process.exit(1);
  }
}

/**
 * Stdio transport wrapper: a response is counted as served only once its
 * stdout write has drained (StdioServerTransport.send resolves on the write
 * callback), then exit(1) — proven to arrive before the disconnect.
 * Everything the SDK assigns (onmessage/onerror/onclose) passes through.
 */
function withDeliveryCounting(inner) {
  return new Proxy(inner, {
    get(target, prop, recv) {
      if (prop === "send") {
        return async (msg) => {
          const result = await target.send(msg);
          if (msg && typeof msg === "object" && msg.id !== undefined && !("method" in msg)) {
            responsesDelivered += 1;
            maybeCrashAfterDelivery();
          }
          return result;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * HTTP transport wrapper: StreamableHTTPServerTransport.send resolves once
 * the response is handed to the web stream — the ServerResponse may not be
 * flushed yet — so exit(1) there would cut the client off mid-response.
 * Instead, reaching N only sets httpCrashPending; the caller (runHttp) arms
 * a 'finish' hook on that request's ServerResponse and exits there.
 */
let httpCrashPending = false;
function withDeliveryCountingHttp(inner) {
  return new Proxy(inner, {
    get(target, prop, recv) {
      if (prop === "send") {
        return async (msg) => {
          const result = await target.send(msg);
          if (msg && typeof msg === "object" && msg.id !== undefined && !("method" in msg)) {
            responsesDelivered += 1;
            if (crashAfter !== undefined && responsesDelivered >= crashAfter) {
              httpCrashPending = true;
            }
          }
          return result;
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

function registerHandlers(server) {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (!serveRequest()) return refusalResult();
    return { tools: buildTools() };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!serveRequest()) return refusalResult();
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
    if (!serveRequest()) return refusalResult();
    return {};
  });
}

// --- transports ----------------------------------------------------------------

async function runStdio() {
  const server = new Server({ name: serverId, version: "0.0.0" }, { capabilities: { tools: {} } });
  registerHandlers(server);
  const transport = withDeliveryCounting(new StdioServerTransport());
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
    const transport = withDeliveryCountingHttp(new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }));
    res.on("close", () => {
      void transport.close().catch(() => {});
    });
    const server = new Server({ name: serverId, version: "0.0.0" }, { capabilities: { tools: {} } });
    registerHandlers(server);
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
      // Crash only after the Nth response is fully flushed to the socket
      // (ServerResponse 'finish' = handed to the OS, not merely 'close').
      if (httpCrashPending) {
        res.once("finish", () => {
          process.stderr.write(`chaos: crash-after=${crashAfter} triggered after ${responsesDelivered} completed responses\n`);
          process.exit(1);
        });
        // Safety net: a response stream that never reaches 'finish' still
        // crashes once the request object closes.
        res.once("close", () => {
          if (!res.writableFinished) return;
          process.stderr.write(`chaos: crash-after=${crashAfter} triggered after ${responsesDelivered} completed responses (close)\n`);
          process.exit(1);
        });
      }
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500).end();
      }
      process.stderr.write(`fake-mcp: request failed: ${String(err)}\n`);
    }
  });

  httpServer.listen(httpPort, "127.0.0.1", () => {
    process.stderr.write(`chaos: fake ${serverId} listening on http://127.0.0.1:${httpPort}/mcp\n`);
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
