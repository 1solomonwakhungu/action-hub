import { build } from "esbuild";
await build({
  entryPoints: ["sea-entry.mjs"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: "sea.cjs",
  logLevel: "error",
  // esbuild CJS output leaves import.meta.url undefined; onnxruntime-web's
  // node entry does createRequire(import.meta.url). Give it a valid absolute
  // file URL as the resolution base (the path need not exist at runtime).
  define: { "import.meta.url": JSON.stringify("file:///sq4/spike/sea.cjs") },
  plugins: [{
    name: "stub-natives",
    setup(b2) {
      b2.onResolve({ filter: /^(onnxruntime-node|sharp)$/ }, () => ({ path: "stub", namespace: "stub" }));
      b2.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: "module.exports = {}; module.exports.default = module.exports;",
        loader: "js",
      }));
    },
  }],
});
console.log("bundled sea.cjs");
