import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCliConfig } from "../dist/config-loader.js";

// The CLI loader accepted any JSON root: an array (or a string, number, true)
// read as "exists, zero servers", so list/doctor/test-search reported an empty
// catalog with exit 0 instead of pointing at the malformed file.
test("loadCliConfig rejects a non-object JSON root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ah-cli-root-"));
  const prevHome = process.env["HOME"];
  process.env["HOME"] = dir;
  try {
    for (const content of ["[]", '"servers"', "42", "true", "null"]) {
      const path = join(dir, "servers.json");
      await writeFile(path, content, "utf8");
      await assert.rejects(
        loadCliConfig(path),
        /expected a JSON object at the document root/,
        `root ${content} must be rejected`,
      );
    }
    const path = join(dir, "ok.json");
    await writeFile(path, JSON.stringify({ servers: [], autoDiscover: false }), "utf8");
    const config = await loadCliConfig(path);
    assert.equal(config.exists, true);
    assert.equal(config.servers.length, 0);
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    await rm(dir, { recursive: true, force: true });
  }
});
