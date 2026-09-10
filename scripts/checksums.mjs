// Generates a `sha256sum -c`-compatible SHA256SUMS.txt for the release
// binaries in a directory (default dist-bin/). Only `action-hub-*` artifacts
// are hashed; build scratch files are ignored.
import { readdir, writeFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { repoRoot, sha256File } from "./lib/util.mjs";

function parseArgs(argv) {
  const args = { dir: resolve(repoRoot, "dist-bin"), out: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir" && argv[i + 1]) args.dir = resolve(argv[++i]);
    else if (argv[i] === "--out" && argv[i + 1]) args.out = resolve(argv[++i]);
  }
  if (!args.out) args.out = resolve(args.dir, "SHA256SUMS.txt");
  return args;
}

function isBinaryArtifact(name) {
  return name.startsWith("action-hub-") && !name.endsWith(".sha256") && name !== "SHA256SUMS.txt";
}

async function main() {
  const { dir, out } = parseArgs(process.argv.slice(2));
  const entries = (await readdir(dir)).filter(isBinaryArtifact).sort();
  if (entries.length === 0) {
    throw new Error(`No action-hub-* artifacts found in ${dir}`);
  }

  const lines = [];
  for (const name of entries) {
    const hash = await sha256File(resolve(dir, name));
    lines.push(`${hash}  ${basename(name)}`);
    process.stderr.write(`  ${hash}  ${name}\n`);
  }

  const body = `${lines.join("\n")}\n`;
  await writeFile(out, body);
  process.stderr.write(`Wrote ${out} (${entries.length} artifact(s))\n`);
}

main().catch((err) => {
  process.stderr.write(`checksums failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
