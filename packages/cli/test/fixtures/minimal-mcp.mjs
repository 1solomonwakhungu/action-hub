// Minimal deterministic stdio MCP server fixture: responds to initialize,
// tools/list (one tool), and tools/call with plain JSON-RPC over stdio.
// Spawns in ~50ms (no SDK import), which keeps large-fleet doctor tests fast.
// Not a general MCP server — doctor tests only need these three methods.
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
let buffered = "";
process.stdin.on("data", (chunk) => {
  buffered += chunk.toString("utf8");
  let idx;
  while ((idx = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, idx);
    buffered = buffered.slice(idx + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});

function handle(message) {
  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "minimal-mcp", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "tools/list") {
    respond(message.id, {
      tools: [
        {
          name: "ping",
          description: "Deterministic ping",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    return;
  }
  if (message.method === "tools/call") {
    respond(message.id, {
      content: [{ type: "text", text: "pong" }],
    });
  }
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
