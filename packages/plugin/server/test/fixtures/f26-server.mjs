// F26 regression fixture (builder-7, FX15): answers initialize and
// tools/list normally, but every tools/call HANGS (never responds) — a
// server that passes heartbeats while every execute times out. Writes its
// pid (F26_PID_FILE) so the test can prove the child was reaped.
import { writeFileSync } from "node:fs";
if (process.env.F26_PID_FILE) writeFileSync(process.env.F26_PID_FILE, String(process.pid));
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const mcp = new McpServer({ name: "f26", version: "1.0.0" });
mcp.registerTool("slow_tool", { description: "hangs forever", inputSchema: {} }, async () => {
  await new Promise(() => undefined); // never settle; the caller times out
});
await mcp.connect(new StdioServerTransport());
