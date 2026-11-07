// Compares two stonks-snapshot runs file by file.
// Usage: node scripts/demo/stonksSnapshotDiff.mjs <baselineDir> [currentDir]
// currentDir defaults to the scene's output folder. Exits 1 on any difference.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const [baseline, current = join(repoRoot, ".scratch/claude/demo/stonks-snapshot")] = process.argv.slice(2);
if (!baseline) {
  console.error("usage: node scripts/demo/stonksSnapshotDiff.mjs <baselineDir> [currentDir]");
  process.exit(2);
}

let differences = 0;
for (const name of readdirSync(baseline).sort()) {
  const other = join(current, name);
  if (!existsSync(other)) { console.log(`missing: ${name}`); differences++; continue; }
  // The fixture commits afresh on every run, so hashes never match between runs.
  const normalize = text => text.replace(/\b[0-9a-f]{7,40}\b/g, "<hash>");
  const a = normalize(readFileSync(join(baseline, name), "utf8"));
  const b = normalize(readFileSync(other, "utf8"));
  if (a === b) { console.log(`same:    ${name}`); continue; }
  differences++;
  let i = 0;
  while (i < a.length && a[i] === b[i]) { i++; }
  console.log(`DIFFERS: ${name} at char ${i}`);
  console.log(`  baseline: …${a.slice(Math.max(0, i - 80), i + 120)}`);
  console.log(`  current:  …${b.slice(Math.max(0, i - 80), i + 120)}`);
}
console.log(differences === 0 ? "identical" : `${differences} file(s) differ`);
process.exit(differences === 0 ? 0 : 1);
