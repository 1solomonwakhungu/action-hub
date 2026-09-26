import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IMPORT_SOURCE_FILTERS, importCommand } from "../dist/commands/import.js";

test("import --source accepts the multi-harness filters and filters codex discoveries", async () => {
  assert.ok(IMPORT_SOURCE_FILTERS.includes("codex"));
  assert.ok(IMPORT_SOURCE_FILTERS.includes("windsurf"));
  assert.ok(IMPORT_SOURCE_FILTERS.includes("cline"));
  assert.ok(IMPORT_SOURCE_FILTERS.includes("roo-code"));

  const home = await mkdtemp(join(tmpdir(), "ah-source-filters-"));
  const originalHome = process.env["HOME"];
  const originalLog = console.log;
  try {
    // Isolated temp HOME so the real user HOME is never read.
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(
      join(home, ".codex", "config.toml"),
      `[mcp_servers.docs]\ncommand = "npx"\nargs = ["-y", "mcp-server-docs"]\n`,
      "utf8",
    );
    process.env["HOME"] = home;

    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.join(" "));
    };
    await importCommand({ source: "codex" });
    console.log = originalLog;

    const output = lines.join("\n");
    assert.match(output, /\[docs\]/);
    assert.match(output, /Source: codex/);
    assert.doesNotMatch(output, /No external MCP servers found/);
  } finally {
    console.log = originalLog;
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});
