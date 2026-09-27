// `action-hub licenses` (SQ4 packaging round 4): prints the vendored
// third-party provenance notice and the applicable license texts. In a
// standalone SEA binary they are read from the embedded SEA assets; in a
// package install they are read from the shipped vendor/ tree.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function licensesCommand(): Promise<number> {
  const assets: Array<{ title: string; seaKey: string; file: string }> = [
    { title: "Vendored third-party provenance", seaKey: "vendor/VENDOR.md", file: "VENDOR.md" },
    { title: "Model weights license (Apache-2.0)", seaKey: "vendor/licenses/Apache-2.0.txt", file: "licenses/Apache-2.0.txt" },
    { title: "onnxruntime-web license (MIT)", seaKey: "vendor/licenses/onnxruntime-LICENSE.txt", file: "licenses/onnxruntime-LICENSE.txt" },
  ];
  // Package layout fallback: dist/commands/licenses.js -> ../../../vendor.
  // (Undefined in a bundled SEA binary — there the SEA assets above are the
  // only source, so this is computed lazily and guarded.)
  let vendorDir: string | undefined;
  try {
    if (import.meta.url) vendorDir = join(dirname(fileURLToPath(import.meta.url)), "../../../vendor");
  } catch {
    vendorDir = undefined;
  }
  for (const asset of assets) {
    let text: string | undefined;
    try {
      const sea = (await import("node:sea")) as { isSea?: () => boolean; getRawAsset?: (key: string) => ArrayBuffer };
      if (sea.isSea?.() && sea.getRawAsset) {
        const bytes = sea.getRawAsset(asset.seaKey);
        if (bytes) text = Buffer.from(bytes).toString("utf8");
      }
    } catch {
      /* not a SEA binary */
    }
    if (text === undefined) {
      if (!vendorDir) throw new Error(`cannot read ${asset.seaKey}: no SEA asset and no vendor tree`);
      text = await readFile(join(vendorDir, asset.file), "utf8");
    }
    process.stdout.write(`===== ${asset.title} =====\n${text.trimEnd()}\n\n`);
  }
  return 0;
}
