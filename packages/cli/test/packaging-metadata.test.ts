import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(resolve(repoRoot, relativePath), "utf8")) as T;
}

interface PackageManifest {
  name: string;
  version: string;
  private?: boolean;
  mcpName?: string;
  homepage?: string;
  bugs?: { url?: string };
  repository?: { type?: string; url?: string; directory?: string };
  keywords?: string[];
  publishConfig?: { access?: string };
}

interface ServerJson {
  $schema: string;
  name: string;
  title: string;
  description: string;
  version: string;
  repository: { url: string; source: string };
  websiteUrl: string;
  packages: Array<{
    registryType: string;
    identifier: string;
    version: string;
    transport: { type: string };
    packageArguments?: Array<{
      type: string;
      value: string;
      isRequired?: boolean;
      description?: string;
    }>;
  }>;
}

interface ReleasePleaseConfig {
  packages: Record<
    string,
    {
      "extra-files"?: Array<{ type: string; path: string; jsonpath?: string }>;
    }
  >;
}

test("publishable npm packages have public access and required metadata", async () => {
  const expectedDirs = ["packages/core", "packages/plugin/server", "packages/cli"];

  for (const dir of expectedDirs) {
    const pkg = await readJson<PackageManifest>(`${dir}/package.json`);
    assert.notEqual(pkg.private, true, `${pkg.name} must not be marked private`);
    assert.equal(pkg.publishConfig?.access, "public", `${pkg.name} must set publishConfig.access to public`);
    assert.equal(pkg.repository?.type, "git", `${pkg.name} must declare git repository`);
    assert.equal(
      pkg.repository?.url,
      "git+https://github.com/1solomonwakhungu/action-hub.git",
      `${pkg.name} must point repository.url at GitHub`,
    );
    assert.equal(pkg.repository?.directory, dir, `${pkg.name} must set repository.directory to ${dir}`);
    assert.equal(pkg.homepage, "https://1solomonwakhungu.github.io/action-hub/");
    assert.equal(pkg.bugs?.url, "https://github.com/1solomonwakhungu/action-hub/issues");
    assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.length > 0, `${pkg.name} must define keywords`);
  }
});

test("server.json matches CLI manifest and MCP Registry constraints", async () => {
  const server = await readJson<ServerJson>("server.json");
  const cliPkg = await readJson<PackageManifest>("packages/cli/package.json");
  const manifest = await readJson<Record<string, string>>(".release-please-manifest.json");
  const rpConfig = await readJson<ReleasePleaseConfig>("release-please-config.json");

  assert.equal(server.$schema, "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
  assert.equal(server.name, "io.github.1solomonwakhungu/action-hub");
  assert.equal(cliPkg.mcpName, server.name, "packages/cli/package.json mcpName must match server.json name");
  assert.ok(
    server.description.length > 0 && server.description.length <= 100,
    `server.json description must be <= 100 chars (got ${server.description.length})`,
  );
  assert.equal(server.version, cliPkg.version);
  assert.equal(server.version, manifest["packages/cli"]);

  const npmPkg = server.packages[0];
  assert.ok(npmPkg, "server.json must include at least one package entry");
  assert.equal(npmPkg.registryType, "npm");
  assert.equal(npmPkg.identifier, cliPkg.name);
  assert.equal(npmPkg.version, cliPkg.version);
  assert.equal(npmPkg.transport.type, "stdio");
  assert.equal(npmPkg.packageArguments?.[0]?.type, "positional");
  assert.equal(npmPkg.packageArguments?.[0]?.value, "start");

  const cliExtraFiles = rpConfig.packages["packages/cli"]?.["extra-files"] ?? [];
  assert.ok(
    cliExtraFiles.some((f) => f.type === "json" && f.path === "/server.json" && f.jsonpath === "$.version"),
    "release-please-config.json must update /server.json $.version",
  );
  assert.ok(
    cliExtraFiles.some(
      (f) => f.type === "json" && f.path === "/server.json" && f.jsonpath === "$.packages[0].version",
    ),
    "release-please-config.json must update /server.json $.packages[0].version",
  );
});
