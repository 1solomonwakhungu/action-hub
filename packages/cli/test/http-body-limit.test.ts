import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import {
  readBoundedBody,
  resolveHttpToken,
  DEFAULT_MAX_BODY_BYTES,
} from "../../plugin/server/dist/http-server.js";

// Regression for PR 31 rework: authenticated request bodies are bounded;
// overflow stops buffering and is answered with 413 by the caller.
test("readBoundedBody accepts a small chunked body", async () => {
  const req = new PassThrough() as unknown as IncomingMessage;
  const pending = readBoundedBody(req, 1024);
  req.write("hello ");
  req.write("chunked ");
  req.write("world");
  req.end();
  assert.equal(await pending, "hello chunked world");
});

test("readBoundedBody rejects a body over the limit and stops buffering", async () => {
  const req = new PassThrough() as unknown as IncomingMessage;
  const pending = readBoundedBody(req, DEFAULT_MAX_BODY_BYTES);
  // Push past the cap in chunks; the reader must drop everything and
  // resolve null rather than accumulate the whole stream.
  for (let i = 0; i < DEFAULT_MAX_BODY_BYTES / (64 * 1024) + 2; i++) {
    req.write(Buffer.alloc(64 * 1024, 0x61));
  }
  req.end();
  assert.equal(await pending, null);
});

// Regression for reviewer-2 MEDIUM: token source is decided before the env
// scrub, so an env-supplied token must never be reported as generated.
test("resolveHttpToken reports the true token source", () => {
  const previous = process.env["ACTION_HUB_HTTP_TOKEN"];
  try {
    process.env["ACTION_HUB_HTTP_TOKEN"] = "from-env";
    assert.equal(resolveHttpToken({}).source, "env");
    assert.equal(resolveHttpToken({ token: "explicit" }).source, "explicit");
    delete process.env["ACTION_HUB_HTTP_TOKEN"];
    const generated = resolveHttpToken({});
    assert.equal(generated.source, "generated");
    assert.ok(generated.token.length > 0);
  } finally {
    if (previous === undefined) delete process.env["ACTION_HUB_HTTP_TOKEN"];
    else process.env["ACTION_HUB_HTTP_TOKEN"] = previous;
  }
});
