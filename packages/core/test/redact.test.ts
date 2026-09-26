import assert from "node:assert/strict";
import { test } from "node:test";
import { redactArg, redactArgs, redactRecord, redactServerConfig, redactUrl, sanitizeErrorForServer } from "../dist/redact.js";

test("redact helpers cover credential-bearing flag, header, URL and record forms", () => {
  const cases: Array<{ label: string; run: () => unknown; expect: unknown | RegExp }> = [
    // (a) credential-like flags, separate and inline
    { label: "--flag VALUE (token)", run: () => redactArgs(["--token", "abc123secret"]), expect: ["--token", "[redacted]"] },
    { label: "--github-token VALUE", run: () => redactArgs(["--github-token", "ghp_1234567890"]), expect: ["--github-token", "[redacted]"] },
    { label: "--api-key=inline", run: () => redactArgs(["--api-key=sk-1234567890"]), expect: ["--api-key=[redacted]"] },
    { label: "--session VALUE", run: () => redactArgs(["--session", "s3ssionvalue"]), expect: ["--session", "[redacted]"] },
    { label: "--pwd VALUE", run: () => redactArgs(["--pwd", "SENTINEL_PWD_35"]), expect: ["--pwd", "[redacted]"] },
    { label: "attached -HName: value", run: () => redactArgs(["-HX-API-Key:SENTINEL_SHORT"]), expect: ["-HX-API-Key: [redacted]"] },
    { label: "-H=Name:value", run: () => redactArgs(["-H=X-API-Key:SENTINEL_SHORT"]), expect: ["-H=X-API-Key: [redacted]"] },
    { label: "backstop known prefix", run: () => redactArg("--model-file=sk-abcdefghijklmnopqrstuv"), expect: "--model-file=[redacted]" },
    { label: "backstop long run", run: () => redactArg("AbCdEf123456789012345678901234"), expect: "[redacted]" },
    { label: "backstop keeps paths", run: () => redactArg("/very/long/path/that/exceeds/twentyfour/chars"), expect: "/very/long/path/that/exceeds/twentyfour/chars" },
    { label: "backstop keeps URLs", run: () => redactArg("https://example.com/a/very/long/path/segment/here"), expect: "https://example.com/a/very/long/path/segment/here" },
    // (b) header forms keep the header name
    { label: "--header VALUE", run: () => redactArgs(["--header", "X-API-Key: secretvalue"]), expect: ["--header", "X-API-Key: [redacted]"] },
    { label: "-H VALUE", run: () => redactArgs(["-H", "Authorization: Bearer abc"]), expect: ["-H", "Authorization: Bearer [redacted]"] },
    { label: "--header=Name: value", run: () => redactArgs(["--header=X-API-Key: secretvalue"]), expect: ["--header=X-API-Key: [redacted]"] },
    { label: "bare Name: value", run: () => redactArg("Authorization: supersecret"), expect: "Authorization: [redacted]" },
    // (c) Bearer/Basic anywhere
    { label: "Bearer inline", run: () => redactArg("Bearer abcdefghij"), expect: "Bearer [redacted]" },
    { label: "Basic inline", run: () => redactArg("Basic dXNlcjpwYXNz"), expect: "Basic [redacted]" },
    // (d) URLs: userinfo, query values, fail closed
    { label: "userinfo", run: () => redactUrl("https://user:hunter2@example.com/mcp"), expect: "https://redacted:redacted@example.com/mcp" },
    { label: "query values", run: () => redactUrl("https://example.com/mcp?token=abc&x=1"), expect: /token=%5Bredacted%5D&x=%5Bredacted%5D/ },
    { label: "unparseable URL", run: () => redactUrl("not-a-valid-url?token=abc"), expect: "[redacted]" },
    // (e) records: values redacted, keys kept
    { label: "env record", run: () => redactRecord({ API_TOKEN: "sk-1234567890", HOME: "/home/u" }), expect: { API_TOKEN: "[redacted]", HOME: "[redacted]" } },
    // benign args survive
    { label: "benign flag", run: () => redactArgs(["--verbose", "--port", "8080"]), expect: ["--verbose", "--port", "8080"] },
  ];

  for (const { label, run, expect } of cases) {
    const result = run();
    if (expect instanceof RegExp) {
      assert.match(String(result), expect, label);
    } else {
      assert.deepEqual(result, expect, label);
    }
  }
});

test("sanitizeErrorForServer uses a low floor and collects header credential parts", () => {
  // 7-char sensitive flag/env value: collected and replaced despite the floor.
  const shortServer = {
    id: "s",
    transport: {
      type: "stdio",
      command: "node",
      args: ["server.js", "--token", "tkn7xyz"],
      env: { API_TOKEN: "tkn7xyz" },
    },
  } as never;
  assert.equal(
    sanitizeErrorForServer(shortServer, "health failed token=tkn7xyz"),
    "health failed token=[redacted]",
  );

  // 14-char Bearer token passed via a header form: the credential component
  // is collected, not just the whole header value.
  const headerServer = {
    id: "h",
    transport: {
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer short14token" },
    },
  } as never;
  assert.equal(
    sanitizeErrorForServer(headerServer, "echo Bearer short14token"),
    "echo [redacted]",
  );
});

test("redactServerConfig redacts stdio and http transports", () => {
  const stdio = redactServerConfig({
    id: "s",
    transport: {
      type: "stdio",
      command: "node",
      args: ["server.js", "--token", "abcdefghij"],
      env: { API_TOKEN: "abcdefghij" },
    },
  } as never);
  assert.deepEqual(stdio.transport.args, ["server.js", "--token", "[redacted]"]);
  assert.deepEqual(stdio.transport.env, { API_TOKEN: "[redacted]" });

  const http = redactServerConfig({
    id: "h",
    transport: {
      type: "http",
      url: "https://user:pass@example.com/mcp?token=abcdefghij",
      headers: { Authorization: "Bearer abcdefghij" },
    },
  } as never);
  assert.ok(!JSON.stringify(http).includes("abcdefghij"));
  assert.ok(!JSON.stringify(http).includes("user:pass"));
  assert.deepEqual(http.transport.headers, { Authorization: "[redacted]" });
});
