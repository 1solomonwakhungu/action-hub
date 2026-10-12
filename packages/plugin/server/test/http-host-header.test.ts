import assert from "node:assert/strict";
import { test } from "node:test";
import { connect } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The HTTP router only ever routes on the request path, but it used to build
// its URL with the Host header as the base: a malformed Host ("[::1", "a b")
// made `new URL` throw out of route() and the request was answered 500
// before authentication. The router must not depend on Host at all.

function rawRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let out = "";
    socket.on("data", (chunk) => (out += chunk.toString("utf8")));
    socket.once("close", () => resolve(out));
    socket.once("error", reject);
    socket.once("connect", () => socket.write(request));
  });
}

test("a malformed Host header does not turn into a 500", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "hub-host-header-"));
  const configPath = join(tmp, "config.json");
  await writeFile(configPath, JSON.stringify({ autoDiscover: false }), "utf8");
  const prevConfig = process.env["ACTION_HUB_CONFIG"];
  process.env["ACTION_HUB_CONFIG"] = configPath;
  try {
    const { startHttpServer } = await import("../dist/http-server.js");
    const handle = await startHttpServer({ port: 0, token: "tok" });
    try {
      for (const host of ["[::1", "a b", "http://x/"]) {
        const reply = await rawRequest(
          handle.port,
          `GET /health HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
        );
        const statusLine = reply.split("\r\n")[0] ?? "";
        assert.match(statusLine, /^HTTP\/1\.1 200 /, `Host "${host}" -> ${statusLine}`);
      }
      // Authentication still gates /mcp regardless of the Host value.
      const unauthenticated = await rawRequest(
        handle.port,
        `POST /mcp HTTP/1.1\r\nHost: [::1\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
      );
      assert.match(unauthenticated.split("\r\n")[0] ?? "", /^HTTP\/1\.1 401 /);
      // And the server keeps serving normal requests afterwards.
      const health = await fetch(`http://127.0.0.1:${handle.port}/health`);
      assert.equal(health.status, 200);
    } finally {
      await handle.close();
    }
  } finally {
    if (prevConfig === undefined) delete process.env["ACTION_HUB_CONFIG"];
    else process.env["ACTION_HUB_CONFIG"] = prevConfig;
  }
});
