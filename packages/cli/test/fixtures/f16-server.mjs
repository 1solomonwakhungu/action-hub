// F16 regression fixture server (builder-7, PR 59). Modes via F16_MODE env:
// - "isError": every tools/call returns isError:true with arbitrary text that
//   LOOKS like a connection error ("Not connected to Slack workspace...").
// - "ok_then_exit": tools/call 1-2 succeed, then the child exits mid-flight.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const mode = process.env.F16_MODE ?? "isError";
let calls = 0;
const mcp = new McpServer({ name: "f16", version: "1.0.0" });
mcp.registerTool(
  "send_message",
  { description: "slack-like", inputSchema: {} },
  async () => {
    calls += 1;
    if (mode === "isError") {
      return {
        content: [{ type: "text", text: "Not connected to Slack workspace. Authenticate this integration first." }],
        isError: true,
      };
    }
    if (calls <= 1) return { content: [{ type: "text", text: "ok" }] };
    // Dead child: exit without responding to the in-flight call.
    process.exit(0);
  },
);
await mcp.connect(new StdioServerTransport());
