#!/usr/bin/env node
/**
 * Minimal stdio MCP fixture server for external stress testing (builder-10).
 * Implements initialize / tools/list / tools/call from a contract-format
 * manifest (see stress CONTRACT.md §Data formats → Tools).
 *
 * Usage: node fixture-server.mjs --manifest <path>
 * Behavior (latencyMs / errorRate / responseBytes) per tool is honored so the
 * same manifests later plug into builder-2's full fake server.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const manifestPath = process.argv[process.argv.indexOf("--manifest") + 1];
if (!manifestPath) {
  console.error("usage: fixture-server.mjs --manifest <path>");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const tools = manifest.tools ?? [];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function textResult(bytes) {
  const filler = "x".repeat(Math.max(0, bytes - 20));
  return { content: [{ type: "text", text: `{"ok":true,"payload":"${filler}"}` }] };
}

const line = createInterface({ input: process.stdin });
line.on("line", (data) => {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: manifest.serverId ?? "fixture", version: "0.1.0" },
      },
    });
  } else if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema ?? { type: "object" },
          annotations: t.annotations,
        })),
      },
    });
  } else if (msg.method === "tools/call") {
    const tool = tools.find((t) => t.name === msg.params?.name);
    if (!tool) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { ...textResult(64), isError: true },
      });
      return;
    }
    const b = tool.behavior ?? {};
    const respond = () => {
      const bytes = b.responseBytes ?? 512;
      if (b.errorRate && Math.random() < b.errorRate) {
        send({ jsonrpc: "2.0", id: msg.id, result: { ...textResult(bytes), isError: true } });
      } else {
        send({ jsonrpc: "2.0", id: msg.id, result: textResult(bytes) });
      }
    };
    if (b.latencyMs) setTimeout(respond, b.latencyMs);
    else respond();
  } else if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
});
