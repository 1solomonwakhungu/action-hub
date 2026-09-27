import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// F53 regression over a REAL stdio child: the server must answer malformed
// JSON-RPC frames instead of silently dropping them (a client waiting on that
// id would otherwise hang). Frames:
//  - top-level `arguments` object (parseable, not JSON-RPC) -> -32600, id
//    echoed when recoverable, else null (the SDK's ZodError exposes neither
//    the frame nor its id — packet F53-R2 option A);
//  - unparseable JSON -> -32700 with id null;
//  - the session keeps serving normal requests afterwards.

test("stdio server replies to malformed JSON-RPC frames (F53)", async () => {
  const root = mkdtempSync(join(tmpdir(), "ah-f53-test-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".cache"), { recursive: true });
  mkdirSync(join(root, "skills"), { recursive: true });
  writeFileSync(join(root, "servers.json"), JSON.stringify({ servers: [] }));
  writeFileSync(join(root, "skills", "SKILL.md"), "");
  const child = spawn(
    "node",
    [join(import.meta.dirname, "../../../../packages/cli/dist/index.js"), "start"],
    {
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: join(root, "tmp"),
        XDG_CACHE_HOME: join(home, ".cache"),
        XDG_CONFIG_HOME: join(home, ".config"),
        ACTION_HUB_CONFIG: join(root, "servers.json"),
        ACTION_HUB_SKILLS_DIR: join(root, "skills"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  // Captured BEFORE the try block so a child that exits early still races.
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    const replies: Array<Record<string, unknown>> = [];
    let buffer = "";
    child.stdout.on("data", (d) => {
      buffer += d.toString();
      for (;;) {
        const i = buffer.indexOf("\n");
        if (i === -1) break;
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        try { replies.push(JSON.parse(line)); } catch { replies.push({ raw: line }); }
      }
    });
    child.stderr.on("data", () => {}); // drain banner
    const waitFor = async (predicate: (m: Record<string, unknown>) => boolean, ms = 8000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const hit = replies.find((m) => predicate(m));
        if (hit !== undefined) return hit;
        if (Date.now() > deadline) return null;
        await delay(50);
      }
    };
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "f53", version: "1.0.0" } } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const init = await waitFor((m) => m.id === 1 && m.result);
    if (!init) throw new Error(`no initialize reply; frames=${JSON.stringify(replies).slice(0, 600)}`);
    // Parseable but not a JSON-RPC message: answered -32600; the SDK's ZodError
    // carries no recoverable id, so the reply uses id null (JSON-RPC 2.0).
    child.stdin.write(JSON.stringify({ arguments: { operation: "search", query: "x" }, id: 9 }) + "\n");
    const invalidRequest = await waitFor((m) => m.error?.code === -32600);
    assert.ok(invalidRequest, "top-level-arguments frame answered with -32600");
    assert.equal(invalidRequest.id, null); // ZodError exposes no recoverable id
    // Unparseable JSON -> -32700 with id null.
    child.stdin.write("{not json\n");
    const parseError = await waitFor((m) => m.error?.code === -32700);
    assert.ok(parseError, "unparseable line answered with -32700");
    assert.equal(parseError.id, null);
    // The session keeps serving normal requests.
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }) + "\n");
    const listed = await waitFor((m) => m.id === 3 && m.result);
    assert.ok(listed, "tools/list still answered after malformed frames");
  } finally {
    // F56a (HYG3): SIGKILL + a blind delay(250) races process reaping.
    // Instead: race the child's 'exit' event against a bounded timeout,
    // assert termination, and only then remove the scratch dir.
    child.kill("SIGKILL");
    const terminated = await Promise.race([
      exited.then(() => true),
      delay(5_000, undefined, { ref: false }).then(() => false),
    ]);
    assert.ok(terminated, "stdio child must terminate after SIGKILL within the bounded wait");
    rmSync(root, { recursive: true, force: true });
  }
});
