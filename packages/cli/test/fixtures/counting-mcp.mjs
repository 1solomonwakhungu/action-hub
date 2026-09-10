import { appendFileSync } from "node:fs";

const countFile = process.env.COUNT_FILE;
if (!countFile) throw new Error("COUNT_FILE is required");
appendFileSync(countFile, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });

let buffered = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (true) {
    const newline = buffered.indexOf(0x0a);
    if (newline < 0) break;
    const line = buffered.subarray(0, newline).toString("utf8");
    buffered = buffered.subarray(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});

function handle(message) {
  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "counting-mcp", version: "1.0.0" },
    });
    return;
  }

  if (message.method === "tools/list") {
    respond(message.id, {
      tools: [
        {
          name: "ping",
          description: "Return the requesting client identifier",
          inputSchema: {
            type: "object",
            properties: { client: { type: "string" } },
            required: ["client"],
            additionalProperties: false,
          },
        },
      ],
    });
    return;
  }

  if (message.method === "tools/call") {
    respond(message.id, {
      content: [{ type: "text", text: String(message.params.arguments.client) }],
    });
  }
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
