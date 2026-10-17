// Publishes the release-please managed workspace packages to npm.
//
// The package list comes from release-please-config.json so there is a single
// source of truth. Packages are published in workspace-dependency order, and a
// package is skipped (never failed) when:
//   - it is marked `"private": true`;
//   - it depends on a workspace package that is private, or on one through a
//     floating `*` range, because the published tarball would not install;
//   - the exact name@version is already on the registry (re-runs are safe).
//
// Usage: node scripts/publish-npm.mjs [--dry-run] [--provenance]
// Requires an authenticated npm (NODE_AUTH_TOKEN / .npmrc) unless --dry-run.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { repoRoot } from "./lib/util.mjs";

const DEP_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];

function parseArgs(argv) {
  const args = { dryRun: false, provenance: false };
  for (const arg of argv) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--provenance") args.provenance = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

const inCi = process.env.GITHUB_ACTIONS === "true";
function notice(msg) {
  console.log(inCi ? `::notice::${msg}` : msg);
}
function warn(msg) {
  console.log(inCi ? `::warning::${msg}` : `warning: ${msg}`);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new Error(`Failed to read ${path}: ${err.message}`);
  }
}

async function loadPackages() {
  const config = await readJson(resolve(repoRoot, "release-please-config.json"));
  const dirs = Object.keys(config.packages ?? {});
  if (dirs.length === 0) throw new Error("release-please-config.json lists no packages");
  const pkgs = [];
  for (const dir of dirs) {
    const manifest = await readJson(resolve(repoRoot, dir, "package.json"));
    pkgs.push({ dir, manifest, name: manifest.name, version: manifest.version });
  }
  return pkgs;
}

/** Orders packages so workspace dependencies are published before dependents. */
function topoSort(pkgs) {
  const byName = new Map(pkgs.map((p) => [p.name, p]));
  const ordered = [];
  const state = new Map();
  const visit = (pkg, trail) => {
    if (state.get(pkg.name) === "done") return;
    if (state.get(pkg.name) === "visiting") {
      throw new Error(`Workspace dependency cycle: ${[...trail, pkg.name].join(" -> ")}`);
    }
    state.set(pkg.name, "visiting");
    for (const field of DEP_FIELDS) {
      for (const dep of Object.keys(pkg.manifest[field] ?? {})) {
        const target = byName.get(dep);
        if (target) visit(target, [...trail, pkg.name]);
      }
    }
    state.set(pkg.name, "done");
    ordered.push(pkg);
  };
  for (const pkg of pkgs) visit(pkg, []);
  return ordered;
}

/** Returns a reason string when the package must not be published, else null. */
function skipReason(pkg, byName) {
  if (pkg.manifest.private) return "marked private";
  for (const field of DEP_FIELDS) {
    for (const [dep, range] of Object.entries(pkg.manifest[field] ?? {})) {
      const target = byName.get(dep);
      if (!target) continue;
      if (target.manifest.private) {
        return `depends on private workspace package ${dep}; the published package would not install`;
      }
      if (range.trim() === "*") {
        return `depends on workspace package ${dep} via "*"; pin it (release-please does this on release)`;
      }
    }
  }
  return null;
}

function isPublished(name, version) {
  const res = spawnSync("npm", ["view", `${name}@${version}`, "version", "--json"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (res.error) throw new Error(`Failed to run npm view: ${res.error.message}`);
  if (res.status === 0) return res.stdout.trim().length > 0;
  // E404 means the package or version does not exist yet; anything else is a real failure.
  if (/E404|404 Not Found/.test(`${res.stdout}${res.stderr}`)) return false;
  throw new Error(`npm view ${name}@${version} failed:\n${res.stderr}`);
}

function publish(pkg, { dryRun, provenance }) {
  const args = ["publish", "--workspace", pkg.dir, "--access", "public"];
  if (provenance) args.push("--provenance");
  if (dryRun) args.push("--dry-run");
  const res = spawnSync("npm", args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (res.error) throw new Error(`Failed to run npm publish: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`npm publish failed for ${pkg.name}@${pkg.version}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pkgs = topoSort(await loadPackages());
  const byName = new Map(pkgs.map((p) => [p.name, p]));
  let published = 0;
  for (const pkg of pkgs) {
    const id = `${pkg.name}@${pkg.version}`;
    const reason = skipReason(pkg, byName);
    if (reason) {
      warn(`Skipping ${id}: ${reason}.`);
      continue;
    }
    if (isPublished(pkg.name, pkg.version)) {
      notice(`Skipping ${id}: already on the npm registry.`);
      continue;
    }
    console.log(`${opts.dryRun ? "Dry-run publishing" : "Publishing"} ${id} from ${pkg.dir}`);
    publish(pkg, opts);
    published++;
  }
  notice(`npm publish ${opts.dryRun ? "dry run " : ""}complete: ${published} package(s) ${opts.dryRun ? "would be " : ""}published.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
