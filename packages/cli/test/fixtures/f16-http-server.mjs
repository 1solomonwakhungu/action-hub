// F16/FX6-R4 HTTP fixture (real Streamable HTTP MCP server, stateless).
// Modes via env (passed through the transport config, not process-global):
// - "ok": tools/call returns a normal result.
// - "mcp32000": tools/call throws McpError(-32000, "Connection closed")
//   while the listener STAYS UP — proves code/message-only inference wrong.
// Writes its pid to HTTP_PID_FILE when set.
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

if (process.env.HTTP_PID_FILE) writeFileSync(process.env.HTTP_PID_FILE, String(process.pid));
const mode = process.env.F16_HTTP_MODE ?? "ok";
// Stateless: a fresh server+transport per request (the SDK's stateless pattern).
function buildApp() {
  const mcp = new McpServer({ name: "f16-http", version: "1.0.0" });
  mcp.registerTool("send_message", { description: "slack-like", inputSchema: {} }, async () => {
    if (mode === "mcp32000") throw new McpError(-32000, "Connection closed");
    return { content: [{ type: "text", text: "ok" }] };
  });
  return mcp;
}
const httpServer = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await buildApp().connect(transport);
  await transport.handleRequest(req, res, body);
});
httpServer.listen(Number(process.env.F16_HTTP_PORT ?? 0), "127.0.0.1", () => {
  if (process.env.F16_HTTP_ADDR_FILE) {
    writeFileSync(process.env.F16_HTTP_ADDR_FILE, String(httpServer.address().port));
  }
});
