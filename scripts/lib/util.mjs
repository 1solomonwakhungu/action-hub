// Shared helpers for the standalone-binary build pipeline.
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const scriptsDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(scriptsDir, "..", "..");

/** Maps a Node platform string to the label used in artifact names. */
export function osLabel(platform = process.platform) {
  switch (platform) {
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return platform;
  }
}

/** The set of targets this project ships binaries for. */
export const SUPPORTED_TARGETS = [
  { os: "macos", arch: "arm64" },
  { os: "macos", arch: "x64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "arm64" },
  { os: "windows", arch: "x64" },
];

export function isSupportedTarget(os = osLabel(), arch = process.arch) {
  return SUPPORTED_TARGETS.some((t) => t.os === os && t.arch === arch);
}

/** Canonical, versionless binary base name, e.g. `action-hub-macos-arm64`. */
export function binaryBaseName(os = osLabel(), arch = process.arch) {
  return `action-hub-${os}-${arch}`;
}

export function binaryFileName(os = osLabel(), arch = process.arch) {
  const base = binaryBaseName(os, arch);
  return os === "windows" ? `${base}.exe` : base;
}

export async function readPackageVersion() {
  const raw = await readFile(resolve(repoRoot, "package.json"), "utf8");
  return JSON.parse(raw).version;
}

/** Version reported by the CLI itself, the single source of truth. */
export async function readCliVersion() {
  const raw = await readFile(resolve(repoRoot, "packages/cli/package.json"), "utf8");
  return JSON.parse(raw).version;
}

export function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

/** Runs a command, inheriting stdio, and throws on a non-zero exit. */
export function run(command, args, options = {}) {
  const printable = [command, ...args].join(" ");
  process.stderr.write(`+ ${printable}\n`);
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`Command failed (exit ${result.status}): ${printable}`);
  }
  return result;
}

/** Like `run`, but captures stdout and returns it trimmed. */
export function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(
      `Command failed (exit ${result.status}): ${[command, ...args].join(" ")}\n${result.stderr ?? ""}`,
    );
  }
  return (result.stdout ?? "").trim();
}

/** The `owner/repo` slug, honouring the value GitHub Actions injects. */
export function repoSlug() {
  return process.env.GITHUB_REPOSITORY || "1solomonwakhungu/action-hub";
}

/** Base URL that release assets for `version` are published under. */
export function releaseBaseUrl(version, repo = repoSlug()) {
  return `https://github.com/${repo}/releases/download/v${version}`;
}

/** Parses a `sha256sum`-style file body into a `{ filename: hash }` map. */
export function parseChecksums(text) {
  const map = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(trimmed);
    if (match) map[match[2]] = match[1].toLowerCase();
  }
  return map;
}
