import assert from "node:assert/strict";
import { test } from "node:test";
import { inheritableEnv } from "../dist/client-factory.js";
import { inheritableEnv as serverInheritableEnv } from "../../plugin/server/dist/sdk-client.js";
import { HUB_HTTP_TOKEN_ENV_VAR } from "../../plugin/server/dist/http-server.js";

// Regression for PR 31 rework: the hub's inbound bearer credential
// (ACTION_HUB_HTTP_TOKEN) must never reach a downstream MCP server
// subprocess through the inherited environment.
test("inheritableEnv strips the hub HTTP token from child environments", () => {
  const sentinel = `sentinel-${Date.now()}`;
  const previous = process.env[HUB_HTTP_TOKEN_ENV_VAR];
  process.env[HUB_HTTP_TOKEN_ENV_VAR] = sentinel;
  try {
    for (const [label, env] of [
      ["cli adapter", inheritableEnv()],
      ["server adapter", serverInheritableEnv()],
    ] as const) {
      assert.equal(env[HUB_HTTP_TOKEN_ENV_VAR], undefined, `${label} leaked the hub token`);
      // Ordinary passthrough vars survive the strip.
      assert.equal(typeof env["PATH"], "string", `${label} dropped PATH`);
    }
  } finally {
    if (previous === undefined) delete process.env[HUB_HTTP_TOKEN_ENV_VAR];
    else process.env[HUB_HTTP_TOKEN_ENV_VAR] = previous;
  }
});
