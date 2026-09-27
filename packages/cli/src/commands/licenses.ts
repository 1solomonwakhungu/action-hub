// `action-hub licenses` (SQ4 packaging rounds 4-5): prints the vendored
// third-party provenance notice and the applicable license texts.
// Resolution order (review-1 round 5 HIGH 1 — the command must work in EVERY
// distribution, not only SEA):
//   1. SEA asset  — the standalone binary embeds the texts;
//   2. bundle inline — esbuild injects them at bundle time (virtual module),
//      so the CJS bundle works with no filesystem at all;
//   3. package filesystem — resolved from the @action-hub/core package
//      location (createRequire(...).resolve), which owns the vendor tree in
//      both workspace checkouts and node_modules installs.
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface LicenseAsset {
  title: string;
  seaKey: string;
  file: string;
}

const ASSETS: LicenseAsset[] = [
  { title: "Vendored third-party provenance", seaKey: "vendor/VENDOR.md", file: "VENDOR.md" },
  { title: "Model weights license (Apache-2.0)", seaKey: "vendor/licenses/Apache-2.0.txt", file: "licenses/Apache-2.0.txt" },
  { title: "onnxruntime-web license (MIT)", seaKey: "vendor/licenses/onnxruntime-LICENSE.txt", file: "licenses/onnxruntime-LICENSE.txt" },
];

/** Bundle-time inlined texts (esbuild virtual module; undefined otherwise). */
interface EmbeddedLicenses {
  "vendor/VENDOR.md"?: string;
  "vendor/licenses/Apache-2.0.txt"?: string;
  "vendor/licenses/onnxruntime-LICENSE.txt"?: string;
}

async function loadEmbedded(): Promise<EmbeddedLicenses | undefined> {
  // Literal specifier (esbuild only resolves literal dynamic imports); tsc
  // cannot resolve the virtual module in source builds — suppressed below.
  // In the source-built dist the import fails at runtime and the caller
  // falls back to the package filesystem resolution.
  try {
    // @ts-ignore esbuild virtual module (resolved by the bundle plugin)
    const mod = (await import("virtual:embedded-licenses")) as { embeddedLicenses?: EmbeddedLicenses };
    return mod.embeddedLicenses;
  } catch {
    return undefined;
  }
}

/** @action-hub/core owns the vendor tree; resolve it from its package entry. */
function coreVendorDir(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    // packages/core/dist/index.js -> packages/core -> vendor
    const coreEntry = require.resolve("@action-hub/core");
    return join(dirname(dirname(coreEntry)), "vendor");
  } catch {
    return undefined;
  }
}

export async function licensesCommand(): Promise<number> {
  const embedded = await loadEmbedded();
  const vendorDir = coreVendorDir();
  for (const asset of ASSETS) {
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
    if (text === undefined) text = embedded?.[asset.seaKey as keyof EmbeddedLicenses];
    if (text === undefined && vendorDir) {
      text = await readFile(join(vendorDir, asset.file), "utf8");
    }
    if (text === undefined) {
      throw new Error(`cannot read ${asset.seaKey}: no SEA asset, no bundle inline, no vendor tree`);
    }
    process.stdout.write(`===== ${asset.title} =====\n${text.trimEnd()}\n\n`);
  }
  return 0;
}
