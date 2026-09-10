import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { VERSION } from "../dist/version.js";

const here = dirname(fileURLToPath(import.meta.url));

test("VERSION constant matches package.json", async () => {
  const pkgRaw = await readFile(resolve(here, "../package.json"), "utf8");
  const pkg = JSON.parse(pkgRaw) as { version: string };
  assert.equal(
    VERSION,
    pkg.version,
    `src/version.ts (${VERSION}) must match package.json (${pkg.version})`,
  );
});
