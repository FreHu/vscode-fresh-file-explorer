// Bundles the extension host code into dist/extension.js (package.json "main").
// One file loads about 4× faster than tsc's ~150 modules. Not minified, so stack
// traces in bug reports stay readable; the source map is for debugging and isn't
// packaged (.vscodeignore: **/*.map). Pass --watch to rebuild on change.
// Tests don't use the bundle's modules: they import tsc's output in out/.

import * as esbuild from "esbuild";

const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  // VS Code 1.105's extension host runs on Node 22.
  target: "node22",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
