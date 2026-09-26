// Doctor fixture: a healthy minimal MCP server that also spawns a
// TERM-ignoring grandchild and records both PIDs to the file named by
// TREE_PIDS_FILE. Used to prove the doctor kills the entire downstream
// process tree (not just the direct child) before it returns.
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const pidFile = process.env["TREE_PIDS_FILE"];
if (pidFile && process.argv[2] !== "child") {
  // Record this server's PID and spawn a grandchild that ignores SIGTERM and
  // hangs on stdin. Record the grandchild PID too.
  appendFileSync(pidFile, `${process.pid}\n`);
  const grandchild = spawn(process.execPath, [import.meta.filename, "child"], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  grandchild.unref();
  appendFileSync(pidFile, `${grandchild.pid}\n`);
}

if (process.argv[2] === "child") {
  process.on("SIGTERM", () => {
    // Deliberately ignores SIGTERM; only a group SIGKILL can end it.
  });
  process.stdin.resume();
} else {
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
