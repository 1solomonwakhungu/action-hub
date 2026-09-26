import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionHub, CatalogCache } from "@action-hub/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/index.js";
import {
  LOAD_DESCRIPTION_MAX_BYTES,
  LOAD_SCHEMA_MAX_BYTES,
  SEARCH_SUMMARY_MAX_BYTES,
  SKILL_INSTRUCTIONS_MAX_BYTES,
} from "../dist/output-hardening.js";

const SECRET = "sk-proj-reviewsecret123456";
const HASH = "0123456789abcdef0123456789abcdef";
const bytes = (s: string | unknown) => Buffer.byteLength(typeof s === "string" ? s : JSON.stringify(s), "utf8");

async function buildRuntime() {
  const bigDescription = `Use key ${SECRET} to connect. Digest ${HASH}. ${"detail ".repeat(14000)}`;
  const bigSchema = {
    type: "object",
    properties: Object.fromEntries([
      ["magic", { type: "string", description: `token ${SECRET}` }],
      ...Array.from({ length: 5000 }, (_, i) => [
        `property_${i}`,
        { type: "string", description: `y${i}` },
      ]),
    ]),
  };
  const hub = new ActionHub({
    clientFactory: async () => ({
      listTools: async () => [
        {
          name: "hostile_tool",
          description: bigDescription,
          inputSchema: bigSchema,
          annotations: { readOnlyHint: true },
        },
      ],
      callTool: async () => ({}),
      close: async () => {},
    }),
    servers: [{ id: "hostile", transport: { type: "stdio", command: "fake" }, trust: "trusted" }],
    bundles: [
      {
        id: "hostile-bundle",
        displayName: "Hostile Bundle",
        description: `Bundle secret ${SECRET}. ${"b".repeat(LOAD_DESCRIPTION_MAX_BYTES + 4096)}`,
        actionIds: ["hostile:hostile_tool"],
      },
    ],
  });
  await hub.indexAll();
  hub.registerSkills([
    {
      id: "skill:hostile",
      name: "Hostile Skill",
      serverId: "skills",
      summary: `Skill summary ${SECRET}`,
      description: `Instructions with ${SECRET}. ${"s".repeat(SKILL_INSTRUCTIONS_MAX_BYTES + 4096)}`,
      trust: "trusted",
    },
  ]);
  return {
    hub,
    cache: new CatalogCache(),
    configHash: "test",
    configPath: "/tmp/nonexistent-action-hub-config.json",
    refreshed: Promise.resolve([]),
    close: async () => {},
  };
}

async function callOperation(runtime: Awaited<ReturnType<typeof buildRuntime>>, args: Record<string, unknown>) {
  const server = createMcpServer(runtime);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.callTool({ name: "action_hub", arguments: args });
  await client.close();
  await server.close();
  assert.ok(!result.isError, JSON.stringify(result).slice(0, 400));
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text);
}

function assertNoSecret(value: unknown): void {
  assert.ok(!JSON.stringify(value).includes(SECRET), "known-prefix secret leaked");
}

test("search caps summaries and redacts schemas end-to-end", async () => {
  const runtime = await buildRuntime();
  const out = await callOperation(runtime, {
    operation: "search",
    query: "hostile",
    include_schema: true,
  });
  assert.ok(out.ok);
  for (const hit of out.results) {
    assert.ok(bytes(hit.summary) <= SEARCH_SUMMARY_MAX_BYTES, "summary exceeds cap incl. marker");
    if (bytes(hit.summary) >= SEARCH_SUMMARY_MAX_BYTES - 64) {
      assert.match(hit.summary, /\[truncated by action_hub: dropped \d+ bytes\]/);
    }
    if (hit.input_schema !== undefined) {
      assert.notEqual(typeof hit.input_schema, "string", "schema must never be partial JSON");
      if (hit.input_schema.truncated === true) {
        assert.ok(typeof hit.input_schema.original_bytes === "number");
        assert.ok(hit.input_schema.note.length > 0);
      } else {
        assert.ok(bytes(hit.input_schema) <= LOAD_SCHEMA_MAX_BYTES);
      }
    }
    assertNoSecret(hit);
  }
  // The long ordinary hash must survive redaction somewhere in the output.
  assert.ok(JSON.stringify(out).includes(HASH), "non-secret hash was mangled");
});

test("load caps descriptions, redacts schemas, and covers skills end-to-end", async () => {
  const runtime = await buildRuntime();
  const tool = await callOperation(runtime, { operation: "load", action_id: "hostile:hostile_tool" });
  assert.ok(bytes(tool.description) <= LOAD_DESCRIPTION_MAX_BYTES, "description exceeds cap incl. marker");
  assert.match(tool.description, /\[truncated by action_hub: dropped \d+ bytes\]/);
  assert.notEqual(typeof tool.input_schema, "string");
  if (tool.input_schema.truncated === true) {
    assert.ok(tool.input_schema.original_bytes > LOAD_SCHEMA_MAX_BYTES);
  } else {
    assert.ok(bytes(tool.input_schema) <= LOAD_SCHEMA_MAX_BYTES);
  }
  assertNoSecret(tool);
  assert.ok(JSON.stringify(tool).includes(HASH));

  const skill = await callOperation(runtime, { operation: "load", action_id: "skill:hostile" });
  assert.ok(bytes(skill.description) <= SKILL_INSTRUCTIONS_MAX_BYTES, "instructions exceed cap incl. marker");
  assert.match(skill.description, /\[truncated by action_hub: dropped \d+ bytes\]/);
  assertNoSecret(skill);
});

test("both bundle-load routes return hardened output end-to-end", async () => {
  const runtime = await buildRuntime();
  for (const args of [
    { operation: "load_bundle", bundle_id: "hostile-bundle" },
    { operation: "load", bundle_id: "hostile-bundle" },
  ]) {
    const out = await callOperation(runtime, args);
    assert.ok(out.ok);
    assert.ok(bytes(out.description) <= LOAD_DESCRIPTION_MAX_BYTES, "bundle description exceeds cap");
    assert.match(out.description, /\[truncated by action_hub: dropped \d+ bytes\]/);
    for (const act of out.actions) {
      assert.ok(bytes(act.summary) <= SEARCH_SUMMARY_MAX_BYTES, "action summary exceeds cap");
      assert.notEqual(typeof act.input_schema, "string", "schema must never be partial JSON");
      if (act.input_schema.truncated !== true) {
        assert.ok(bytes(act.input_schema) <= LOAD_SCHEMA_MAX_BYTES);
      }
    }
    assertNoSecret(out);
  }
});
