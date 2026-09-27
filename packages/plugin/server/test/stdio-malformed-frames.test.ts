import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// F53 regression: a real stdio child must answer malformed frames instead of
// silently dropping them (-32600 for parseable non-JSON-RPC with an id,
// -32700 with id null for unparseable JSON), and keep serving afterwards.

test("stdio server replies to malformed JSON-RPC frames (F53)", async () => {
  const root = mkdtempSync(join(tmpdir(), "ah-f53-test-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".cache"), { recursive: true });
  mkdirSync(join(home, ".config"), { recursive: true });
  mkdirSync(join(root, "skills"), { recursive: true });
  writeFileSync(join(root, "servers.json"), JSON.stringify({ servers: [] }));
  writeFileSync(join(root, "skills", "SKILL.md"), "");
  const env = {
    ...process.env,
    HOME: home,
    TMPDIR: join(root, "tmp"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    ACTION_HUB_CONFIG: join(root, "servers.json"),
    ACTION_HUB_SKILLS_DIR: join(root, "skills"),
  };
  const child = spawn("node", [join(import.meta.dirname, "../../../../packages/cli/dist/index.js"), "start"], {
    env, stdio: ["pipe", "pipe", "pipe"],
  });
  const replies: unknown[] = [];
  let childErr = "";
  let buffer = "";
  {
    // gather every JSON-RPC frame the child writes
    child.stdout.on("data", (d) => {
      buffer += d;
      for (;;) {
        const i = buffer.indexOf("\n");
        if (i === -1) break;
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        try { replies.push(JSON.parse(line)); } catch { replies.push({ raw: line }); }
      }
    });
    child.stderr.on("data", (d) => { childErr += d.toString(); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "f53", version: "1.0.0" } } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const waitFor = async (pred, ms = 8000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const hit = replies.find(pred);
        if (hit) return hit;
        if (Date.now() > deadline) return null;
        await delay(50);
      }
    };
    // initialize must still work
    const init = await waitFor((m) => m.id === 1 && m.result);
    if (!init) throw new Error(`no initialize reply; frames=${JSON.stringify(replies).slice(0, 600)} stderr=${childErr.slice(0, 300)}`);
    // 1. parseable object with an id, invalid shape -> -32600 with that id
    child.stdin.write(JSON.stringify({ arguments: { operation: "search", query: "x" }, id: 9 }) + "\n");
    const invalidRequest = await waitFor((m) => m.id === 9);
    assert.ok(invalidRequest, "got a reply for the top-level-arguments frame");
    assert.equal(invalidRequest.error?.code, -32600);
    // 2. unparseable JSON -> -32700 with id null
    child.stdin.write("{not json\n");
    const parseError = await waitFor((m) => m.id === null && m.error);
    assert.ok(parseError, "got a reply for the unparseable line");
    assert.equal(parseError.error?.code, -32700);
    // 3. the session still works
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }) + "\n");
    const listed = await waitFor((m) => m.id === 3 && m.result);
    assert.ok(listed, "tools/list still answered after malformed frames");
    child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
