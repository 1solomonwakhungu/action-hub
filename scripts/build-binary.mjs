// Produces a standalone Action Hub executable for the host platform using
// Node's Single Executable Application (SEA) support. SEA cannot cross-compile,
// so each OS/arch binary must be built on a matching runner (see the release
// workflow matrix). Requires `build/action-hub.cjs` (run scripts/bundle.mjs).
import { mkdir, copyFile, rm, writeFile, chmod, access } from "node:fs/promises";
import { resolve } from "node:path";
import {
  repoRoot,
  osLabel,
  isSupportedTarget,
  binaryFileName,
  readCliVersion,
  run,
} from "./lib/util.mjs";

const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const buildDir = resolve(repoRoot, "build");
const outDir = resolve(repoRoot, "dist-bin");
const bundle = resolve(buildDir, "action-hub.cjs");
const seaConfig = resolve(buildDir, "sea-config.json");
const seaBlob = resolve(buildDir, "sea-prep.blob");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function postjectCli() {
  return resolve(repoRoot, "node_modules", "postject", "dist", "cli.js");
}

async function main() {
  const os = osLabel();
  const arch = process.arch;

  if (!isSupportedTarget(os, arch)) {
    throw new Error(
      `Unsupported build target ${os}-${arch}. Supported: macos-arm64, macos-x64, linux-x64, linux-arm64, windows-x64.`,
    );
  }
  if (!(await exists(bundle))) {
    throw new Error(`Missing ${bundle}. Run \`node scripts/bundle.mjs\` first.`);
  }

  const version = await readCliVersion();
  const outName = binaryFileName(os, arch);
  const outPath = resolve(outDir, outName);

  await mkdir(outDir, { recursive: true });
  await rm(seaBlob, { force: true });

  // 1. Generate the SEA preparation blob from the bundle.
  await writeFile(
    seaConfig,
    JSON.stringify(
      { main: bundle, output: seaBlob, disableExperimentalSEAWarning: true },
      null,
      2,
    ),
  );
  run(process.execPath, ["--experimental-sea-config", seaConfig]);

  // 2. Copy the running Node binary as the host for the blob.
  await rm(outPath, { force: true });
  await copyFile(process.execPath, outPath);

  // 3. macOS refuses to run a resigned-later binary that still carries its old
  //    signature; strip it before injection, re-sign ad-hoc afterwards.
  if (os === "macos") {
    run("codesign", ["--remove-signature", outPath]);
  }

  // 4. Inject the blob into the copied binary. Invoke postject's JS CLI with
  //    the current Node rather than the `.bin` shim: on Windows `spawnSync` of a
  //    `.cmd` throws EINVAL, and calling the script directly is portable.
  const postjectArgs = [
    postjectCli(),
    outPath,
    "NODE_SEA_BLOB",
    seaBlob,
    "--sentinel-fuse",
    SENTINEL_FUSE,
  ];
  if (os === "macos") {
    postjectArgs.push("--macho-segment-name", "NODE_SEA");
  }
  run(process.execPath, postjectArgs);

  // 5. Re-sign (macOS) and make executable (POSIX).
  if (os === "macos") {
    run("codesign", ["--sign", "-", outPath]);
  }
  if (os !== "windows") {
    await chmod(outPath, 0o755);
  }

  process.stderr.write(`Built ${outPath} (v${version}, ${os}-${arch})\n`);
  process.stdout.write(`${outPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`build-binary failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
