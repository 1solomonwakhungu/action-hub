/**
 * stress/cli-scale.test.mjs — unit tests for stress/cli-scale.mjs internals.
 * Run: node --test stress/cli-scale.test.mjs
 * (Imports the ESM source directly; no dist build needed.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __test } from "./cli-scale.mjs";

const { writeToolManifests, buildConfigSkills, writeSkillFixtures, FAKE_STDIO_SERVER } = __test;

test("fixture generation is deterministic for a fixed seed", () => {
  const dir1 = mkdtempSync(join(tmpdir(), "cli-scale-t1-"));
  const dir2 = mkdtempSync(join(tmpdir(), "cli-scale-t2-"));
  try {
    // Two independent runs of the same generation must be byte-identical;
    // the module PRNG is re-seeded between runs to simulate fresh processes.
    const run = (dir) => {
      __test.reseed(42);
      writeToolManifests(__test.SCALES.small, dir);
      writeSkillFixtures(__test.SCALES.small, join(dir, "skills"));
      const out = {};
      for (const f of readdirSync(join(dir, "tools"))) {
        out[f] = readFileSync(join(dir, "tools", f)).toString();
      }
      return out;
    };
    const a = run(dir1);
    const b = run(dir2);
    assert.deepEqual(Object.keys(a), Object.keys(b));
    for (const k of Object.keys(a)) assert.equal(a[k], b[k], `manifest ${k} differs between runs`);
  } finally {
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
});

test("small-scale fixtures have the expected shape (contract formats)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-scale-t3-"));
  try {
    const serverIds = writeToolManifests(__test.SCALES.small, dir);
    const manifest = JSON.parse(readFileSync(join(dir, "tools", serverIds[0] + ".json"), "utf8"));
    assert.equal(manifest.serverId, serverIds[0]);
    assert.equal(manifest.tools.length, __test.SCALES.small.toolsPerServer);
    for (const tool of manifest.tools) {
      assert.ok(tool.name, "tool name present");
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(tool.description.includes("(seeded fixture"), "description marks seeded fixtures");
    }
    const skills = buildConfigSkills({ skills: 5 });
    assert.equal(skills.length, 5);
    for (const s of skills) {
      assert.ok(s.id.startsWith("skill:"), "skill id uses skill:<slug> format");
      assert.ok(s.summary.length > 0 && s.description.length > 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inline fake stdio server answers initialize and tools/list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-scale-t4-"));
  try {
    const manifest = {
      serverId: "test-server",
      tools: [
        { name: "do_thing", description: "does a thing", inputSchema: { type: "object", properties: {} } },
      ],
    };
    const manifestPath = join(dir, "test-server.json");
    const serverPath = join(dir, "fake-stdio-server.mjs");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(serverPath, FAKE_STDIO_SERVER);

    const child = spawn(process.execPath, [serverPath, "--manifest", manifestPath], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    const responses = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line.trim()) responses.push(JSON.parse(line));
      }
    });
    const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for responses")), 5000);
      const poll = setInterval(() => {
        if (responses.length >= 2) { clearInterval(poll); clearTimeout(timer); resolve(); }
      }, 25);
    });
    child.kill();
    assert.equal(responses[0].id, 1);
    assert.equal(responses[0].result.protocolVersion, "2025-06-18");
    assert.equal(responses[0].result.serverInfo.name, "test-server");
    assert.equal(responses[1].id, 2);
    assert.equal(responses[1].result.tools[0].name, "do_thing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
