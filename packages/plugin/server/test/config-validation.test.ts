import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";

// Config-boundary regressions for loadConfig (packages/plugin/server/src/config.ts).
// Every case here used to be accepted silently; each now fails closed with a
// message that names the offending field.

async function withConfig<T>(content: string, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "hub-config-validation-"));
  const path = join(dir, "servers.json");
  await writeFile(path, content, "utf8");
  try {
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The runtime loader (start / serve / daemon) used to return only
// { type, url, headers } for HTTP transports, so the `auth` block never
// reached the SDK client factory and OAuth servers were connected with no
// token binding.
test("an HTTP transport's OAuth auth block survives loadConfig", async () => {
  const auth = {
    type: "oauth2",
    tokenUrl: "https://example.test/oauth/token",
    authorizationUrl: "https://example.test/oauth/authorize",
    clientIdEnv: "ACTION_HUB_TEST_OAUTH_CLIENT_ID",
    scopes: ["repo"],
  };
  const config = {
    autoDiscover: false,
    servers: [{ id: "gh", transport: { type: "http", url: "https://example.test/mcp", headers: { "X-Static": "1" }, auth } }],
  };
  await withConfig(JSON.stringify(config), async (path) => {
    const loaded = await loadConfig(path);
    const transport = loaded.servers[0]!.transport;
    assert.equal(transport.type, "http");
    if (transport.type === "http") {
      assert.deepEqual(transport.auth, auth, "auth block carried through verbatim");
      assert.deepEqual(transport.headers, { "X-Static": "1" }, "static headers still parsed");
    }
  });
  // A present-but-malformed auth block fails closed instead of silently
  // connecting without authentication.
  const malformed = { ...config, servers: [{ id: "gh", transport: { type: "http", url: "https://example.test/mcp", auth: { type: "oauth2" } } }] };
  await withConfig(JSON.stringify(malformed), async (path) => {
    await assert.rejects(loadConfig(path), /servers\[0\]\.transport\.auth must be an OAuth 2.0 client config/);
  });
  // No auth block: no auth key, as before.
  const plain = { ...config, servers: [{ id: "gh", transport: { type: "http", url: "https://example.test/mcp" } }] };
  await withConfig(JSON.stringify(plain), async (path) => {
    const loaded = await loadConfig(path);
    assert.equal("auth" in loaded.servers[0]!.transport, false);
  });
});
