import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve, join } from "node:path";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const BUNDLE_CONFIG = {
  servers: [],
  bundles: [
    {
      id: "triage-issue",
      displayName: "Triage Bundle",
      description: "Issue triage toolset",
      actionIds: ["srv:tool1"],
    },
  ],
};

test("bundle --export prints the bundle as JSON, unknown ids and valueless --export exit 1", async () => {
  const tempDir = resolve(tmpdir(), `action-hub-bundle-export-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });
  const cfgPath = join(tempDir, "servers.json");
  await writeFile(cfgPath, JSON.stringify(BUNDLE_CONFIG), "utf8");
  // Resolve relative to THIS test file: resolve("dist/index.js") is
  // cwd-relative and fails when tests run from the repo root (F33).
  const bin = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const env = { ...process.env, HOME: tempDir };

  try {
    // Known id: pretty JSON on stdout, exit 0.
    const ok = spawnSync("node", [bin, "bundle", "--export", "triage-issue", "--config", cfgPath], {
      encoding: "utf8",
      env,
    });
    assert.equal(ok.status, 0, ok.stderr);
    const printed = JSON.parse((ok.stdout ?? "").trim());
    assert.equal(printed.id, "triage-issue");
    assert.equal(printed.displayName, "Triage Bundle");

    // Unknown id: message on stderr, exit 1.
    const missing = spawnSync("node", [bin, "bundle", "--export", "nope", "--config", cfgPath], {
      encoding: "utf8",
      env,
    });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr ?? "", /Bundle not found: nope/);

    // Present but valueless --export: exit 1.
    const valueless = spawnSync("node", [bin, "bundle", "--export", "--config", cfgPath], {
      encoding: "utf8",
      env,
    });
    assert.equal(valueless.status, 1);
    assert.match(valueless.stderr ?? "", /--export requires a bundle id/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
