import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

const stdio = (extra: Record<string, unknown> = {}) => ({
  autoDiscover: false,
  servers: [{ id: "srv", transport: { type: "stdio", command: "node", ...extra } }],
});

test("a non-object JSON root is rejected instead of loading an empty hub", async () => {
  for (const content of [
    JSON.stringify([{ id: "srv", transport: { type: "stdio", command: "node" } }]),
    JSON.stringify("servers"),
    "42",
    "true",
    "null",
  ]) {
    await withConfig(content, async (path) => {
      await assert.rejects(
        loadConfig(path),
        (cause: unknown) =>
          cause instanceof Error && cause.message.includes("must contain a JSON object"),
        `root ${content.slice(0, 20)} must be rejected`,
      );
    });
  }
  // The empty object and a missing file still load (fresh-install behavior).
  await withConfig("{}", async (path) => {
    const config = await loadConfig(path);
    assert.equal(config.servers.length, 0);
  });
});

test("transport.args with a non-string entry is an error, not a silently shorter command line", async () => {
  await withConfig(JSON.stringify(stdio({ args: ["-y", "pkg", "--port", 3000] })), async (path) => {
    await assert.rejects(loadConfig(path), /servers\[0\]\.transport\.args must be an array of strings/);
  });
  await withConfig(JSON.stringify(stdio({ args: "--port 3000" })), async (path) => {
    await assert.rejects(loadConfig(path), /servers\[0\]\.transport\.args must be an array of strings/);
  });
});

test("transport.env and http headers with non-string values are rejected", async () => {
  await withConfig(JSON.stringify(stdio({ env: { PORT: 3000, OK: "1" } })), async (path) => {
    await assert.rejects(loadConfig(path), /servers\[0\]\.transport\.env\.PORT must be a string/);
  });
  const http = {
    autoDiscover: false,
    servers: [{ id: "remote", transport: { type: "http", url: "http://127.0.0.1:1/mcp", headers: { "X-Retries": 3 } } }],
  };
  await withConfig(JSON.stringify(http), async (path) => {
    await assert.rejects(loadConfig(path), /servers\[0\]\.transport\.headers\.X-Retries must be a string/);
  });
});

test("denyTools/allowTools written as a string no longer vanish into 'no filter'", async () => {
  const withDeny = { autoDiscover: false, servers: [{ id: "srv", denyTools: "delete_repo", transport: { type: "stdio", command: "node" } }] };
  await withConfig(JSON.stringify(withDeny), async (path) => {
    await assert.rejects(loadConfig(path), /servers\[0\]\.denyTools must be an array of strings/);
  });
  const withAllow = { autoDiscover: false, servers: [{ id: "srv", allowTools: ["read", 7], transport: { type: "stdio", command: "node" } }] };
  await withConfig(JSON.stringify(withAllow), async (path) => {
    await assert.rejects(loadConfig(path), /servers\[0\]\.allowTools must be an array of strings/);
  });
  // Well-formed lists still parse.
  const ok = { autoDiscover: false, servers: [{ id: "srv", denyTools: ["delete_repo"], transport: { type: "stdio", command: "node", args: ["a", "b"] } }] };
  await withConfig(JSON.stringify(ok), async (path) => {
    const config = await loadConfig(path);
    assert.deepEqual(config.servers[0]?.denyTools, ["delete_repo"]);
    assert.deepEqual(config.servers[0]?.transport.type === "stdio" ? config.servers[0].transport.args : [], ["a", "b"]);
  });
});

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

test("${VAR} expands inside a ~-prefixed cwd exactly as it does in an absolute one", async () => {
  const previous = process.env["ACTION_HUB_TEST_CWD_SEGMENT"];
  process.env["ACTION_HUB_TEST_CWD_SEGMENT"] = "projects";
  try {
    await withConfig(JSON.stringify(stdio({ cwd: "~/${ACTION_HUB_TEST_CWD_SEGMENT}/hub" })), async (path) => {
      const config = await loadConfig(path);
      const transport = config.servers[0]!.transport;
      assert.equal(transport.type, "stdio");
      if (transport.type === "stdio") {
        assert.equal(transport.cwd, resolve(homedir(), "projects", "hub"));
      }
    });
  } finally {
    if (previous === undefined) delete process.env["ACTION_HUB_TEST_CWD_SEGMENT"];
    else process.env["ACTION_HUB_TEST_CWD_SEGMENT"] = previous;
  }
});
