// Deterministic fail-first-listTools fixture for doctor retry tests (FX8-R2).
//
// A minimal stdio MCP server whose FIRST tools/list request is delayed beyond
// any reasonable probe timeout (FAIL_MS), then serves normally. Every doctor
// run creates a fresh client, so attempt 1 deterministically times out on
// tools/list and attempt 2 succeeds — this is what lets a test prove the
// retry machinery actually engaged ("recovered on retry" in the output).
//
// Unlike the chaos slow-start flag, this delay is on the request itself, not
// on server startup, so it is not swallowed by an unbounded activate().
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const failMs = Number(process.env.FAIL_MS ?? 3000);

const server = new Server(
  { name: "fail-first-list-tools", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

import { appendFileSync } from "node:fs";
const trace = process.env.FAIL_TRACE;
const t0 = Date.now();
let firstListSeen = false;
server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (trace) appendFileSync(trace, "list at " + (Date.now() - t0) + "ms");
  if (!firstListSeen) {
    firstListSeen = true;
    // Deterministic, IMMEDIATE failure on the first list request: no timing
    // race with the SDK's serialized request queue, no dependence on probe
    // timeouts. The doctor's bounded retry gets list #2, which succeeds.
    if (failMs > 0) throw new Error("synthetic first-list failure");
  }
  return {
    tools: [
      {
        name: "ping",
        description: "Deterministic ping",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  return {
    content: [{ type: "text", text: `pong:${request.params.name}` }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
