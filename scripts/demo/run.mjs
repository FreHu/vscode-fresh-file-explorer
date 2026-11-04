// Captures documentation screenshots of the extension in a real VS Code window.
// Usage: npm run compile && node scripts/demo/run.mjs [sceneName...] [--out <dir>]
// Scenes live in scenes/<name>.mjs. Default output: .scratch/claude/demo/shots,
// pass --out docs/img to replace the README images.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodeGif, verifyGif } from "./encodeGif.mjs";
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
const summary = [];
const seconds = ms => (ms / 1000).toFixed(1);
const runStart = performance.now();
for (const name of sceneNames) {
  const scene = (await import(pathToFileURL(join(here, "scenes", `${name}.mjs`)).href)).default;
  // Per-phase wall-clock time, so a slow scene says where the time goes.
  const phases = {};
  let mark = performance.now();
  const lap = phase => { const now = performance.now(); phases[phase] = (phases[phase] ?? 0) + now - mark; mark = now; };

  // One VS Code per scene: scenes can't leak view state, settings or open pickers into each other.
  // Default workspace: the fixture repo itself. A scene can lay out its own around it.
  const workspace = scene.workspace
    ? scene.workspace({ stateDir, buildFixtureRepo })
    : buildFixtureRepo(join(stateDir, "orbit-shop"));
  lap("fixture");
  const { app, page } = await launchVSCode({ repoRoot, workspace, stateDir, settings: scene.settings, window: scene.window });
  lap("launch");
  let status = "ok";
  try {
    // A scene returns one PNG, or a list of frames that becomes a GIF.
    const result = await scene.capture(page, { app });
    lap("capture");
    const bytes = Array.isArray(result) ? await encodeGif(page, result) : result;
    if (Array.isArray(result)) {
      lap("encode");
      // The frames as stills, for checking each one: image viewers often show only a GIF's first frame.
      const framesDir = join(stateDir, "frames", name);
      mkdirSync(framesDir, { recursive: true });
      result.forEach((f, i) => writeFileSync(join(framesDir, `${i + 1}.png`), f.png));
      // Read the GIF back: held frames must match their stills (only palette rounding allowed).
      const check = await verifyGif(page, bytes, result);
      check.frames.forEach((png, i) => writeFileSync(join(framesDir, `gif-${String(i + 1).padStart(2, "0")}.png`), png));
      console.log(`  ${check.frameCount} GIF frames; mean error of held frames vs stills (0–255): ${check.keyFrameErrors.join(", ")}`);
      lap("verify");
    }
    const file = join(outDir, scene.output);
    writeFileSync(file, bytes);
    console.log(`${name} → ${file} (${Math.round(bytes.length / 1024)} KB)`);
  } catch (err) {
    failed++;
    status = "FAILED";
    const file = join(stateDir, `${name}.failure.png`);
    await page.screenshot({ path: file }).catch(() => {});
    console.error(`${name} failed: ${err instanceof Error ? err.message : String(err)}\n  window at failure: ${file}`);
  } finally {
    await app.close();
    lap("close");
  }
  const total = Object.values(phases).reduce((a, b) => a + b, 0);
  const detail = Object.entries(phases).map(([p, ms]) => `${p} ${seconds(ms)}`).join(", ");
  console.log(`  ${name}: ${seconds(total)} s (${detail})`);
  summary.push({ name, status, total, detail });
}

if (summary.length > 1) {
  const width = Math.max(...summary.map(s => s.name.length));
  console.log("\nscene timings (wall clock, s):");
  for (const s of [...summary].sort((a, b) => b.total - a.total)) {
    console.log(`  ${s.name.padEnd(width)}  ${seconds(s.total).padStart(5)}  ${s.status === "ok" ? "" : `${s.status}  `}${s.detail}`);
  }
  console.log(`  ${"total".padEnd(width)}  ${seconds(performance.now() - runStart).padStart(5)}`);
}
process.exit(failed > 0 ? 1 : 0);
