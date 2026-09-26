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
 *   crash-after=N     exit(1) after serving the Nth JSON-RPC request (any
 *                     handled method), preceded by a stderr note
 *   hang-rate=R       per tools/call draw: never respond to that call
 *   slow-start-ms=N   delay before the server serves its first request
 *   huge-bytes=N      pad every successful tools/call result to ~N bytes
 *   stderr-secret=V   print "chaos: secret=V" to stderr once at startup
 *
 * Deterministic given the manifest; no network beyond the local transport.
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

let requestsServed = 0;
function serveRequest() {
  requestsServed += 1;
  if (crashAfter !== undefined && requestsServed >= crashAfter) {
    process.stderr.write(`chaos: crash-after=${crashAfter} triggered\n`);
    process.exit(1);
  }
}

function toolBehavior(name) {
  return manifest.tools.find((t) => t.name === name)?.behavior ?? {};
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
    serveRequest();
    return { tools: buildTools() };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    serveRequest();
    const behavior = toolBehavior(request.params.name);
    // Hang-rate draws only on tools/call, per contract: initialize and
    // tools/list always proceed so clients can connect and index.
    if (hangRate > 0 && Math.random() < hangRate) {
      return hangForever();
    }
    const latencyMs = Number(behavior.latencyMs ?? 0);
    if (latencyMs > 0) await sleep(latencyMs);
    const errorRate = Number(behavior.errorRate ?? 0);
    if (errorRate > 0 && Math.random() < errorRate) {
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
    serveRequest();
    return {};
  });
}

// --- transports ----------------------------------------------------------------

async function runStdio() {
  const server = new Server({ name: serverId, version: "0.0.0" }, { capabilities: { tools: {} } });
  registerHandlers(server);
  const transport = new StdioServerTransport();
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

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close().catch(() => {});
    });
    const server = new Server({ name: serverId, version: "0.0.0" }, { capabilities: { tools: {} } });
    registerHandlers(server);
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
if (slowStartMs > 0) await sleep(slowStartMs);

if (transportKind === "http") {
  void runHttp();
} else {
  void runStdio();
}
