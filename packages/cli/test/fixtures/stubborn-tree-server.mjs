// Doctor fixture: a healthy minimal MCP server whose grandchild stays INSIDE
// the downstream process group (spawned without detached), ignores SIGTERM
// via an installed handler, and is kept alive by a durable setInterval (not
// by an inherited pipe). The server only answers initialize AFTER the
// grandchild has signalled readiness, so by the time the doctor can connect,
// the escape-avoidance state is fully in place. Both PIDs are recorded to
// TREE_PIDS_FILE; the doctor must kill the whole tree.
import { appendFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const pidFile = process.env["TREE_PIDS_FILE"];
const grandchildReadyFile = pidFile ? `${pidFile}.ready` : undefined;

if (pidFile && process.argv[2] !== "child") {
  appendFileSync(pidFile, `${process.pid}\n`);
  // NOT detached: the grandchild inherits the server's process group, so only
  // a group-wide signal can reach it.
  const grandchild = spawn(process.execPath, [import.meta.filename, "child"], {
    detached: false,
    stdio: ["ignore", "ignore", "ignore"],
  });
  grandchild.unref();
  appendFileSync(pidFile, `${grandchild.pid}\n`);
  // Wait for the grandchild to confirm its SIGTERM handler is installed
  // before serving MCP traffic, so the leak window is deterministic.
  const deadline = Date.now() + 5000;
  while (!existsSync(grandchildReadyFile) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
} else if (process.argv[2] === "child") {
  process.on("SIGTERM", () => {
    // Deliberately ignores SIGTERM; only a group SIGKILL can end it.
  });
  // Durable handle: keeps the event loop alive regardless of any pipe.
  setInterval(() => {}, 1000);
  if (grandchildReadyFile) writeFileSync(grandchildReadyFile, "ready\n");
}

if (process.argv[2] !== "child") {
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
        serverInfo: { name: "stubborn-tree", version: "1.0.0" },
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
      respond(message.id, { content: [{ type: "text", text: "pong" }] });
    }
  }

  function respond(id, result) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }
}
