// Bundles the webview panel scripts into media/. Pass --watch to rebuild on change.

import * as esbuild from "esbuild";

const ENTRY_POINTS = [
  "src/webview/gitLogLPanel.ts",
  "src/webview/diffSearchPanel.ts",
  "src/webview/perfBenchmarkPanel.ts",
  "src/webview/stonksPanel.ts",
  "src/webview/branchCompareSettings.ts",
];

const options = {
  entryPoints: ENTRY_POINTS,
  bundle: true,
  outdir: "media",
  format: "iife",
  platform: "browser",
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
