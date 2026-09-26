import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { readBoundedBody, DEFAULT_MAX_BODY_BYTES } from "../../copilot-plugin/server/dist/http-server.js";

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
