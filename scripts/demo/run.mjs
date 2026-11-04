// Captures documentation screenshots of the extension in a real VS Code window.
// Usage: npm run compile && node scripts/demo/run.mjs [sceneName...] [--out <dir>]
// Scenes live in scenes/<name>.mjs. Default output: .scratch/claude/demo/shots,
// pass --out docs/img to replace the README images.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildFixtureRepo } from "./fixtureRepo.mjs";
import { launchVSCode } from "./launchVSCode.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const stateDir = join(repoRoot, ".scratch/claude/demo");

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = resolve(repoRoot, outIndex >= 0 ? args.splice(outIndex, 2)[1] : join(stateDir, "shots"));
const sceneNames = args.length > 0
  ? args
  : readdirSync(join(here, "scenes")).filter(f => f.endsWith(".mjs")).map(f => basename(f, ".mjs"));

if (!existsSync(join(repoRoot, "out/extension.js"))) {
  console.error("out/extension.js missing: run `npm run compile` first.");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
let failed = 0;
for (const name of sceneNames) {
  const scene = (await import(pathToFileURL(join(here, "scenes", `${name}.mjs`)).href)).default;
  // One VS Code per scene: scenes can't leak view state, settings or open pickers into each other.
  const workspace = buildFixtureRepo(join(stateDir, "orbit-shop"));
  const { app, page } = await launchVSCode({ repoRoot, workspace, stateDir, settings: scene.settings });
  try {
    const png = await scene.capture(page);
    const file = join(outDir, scene.output);
    writeFileSync(file, png);
    console.log(`${name} → ${file}`);
  } catch (err) {
    failed++;
    const file = join(stateDir, `${name}.failure.png`);
    await page.screenshot({ path: file }).catch(() => {});
    console.error(`${name} failed: ${err instanceof Error ? err.message : String(err)}\n  window at failure: ${file}`);
  } finally {
    await app.close();
  }
}
process.exit(failed > 0 ? 1 : 0);
