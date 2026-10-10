// Times parseMarkdownHeadings on a generated worst-case pinned todo file.
// Run after `npm run compile`:  node scripts/benchMarkdownHeadings.mjs [headings] [linesPerSection]
//
// The document mixes levels 1-4 (with skips), body text, list items, and a
// code fence full of `#` lines every 10th section, so every parser branch runs.
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const { parseMarkdownHeadings } = require("../out/fresh-files/markdownHeadings.js");

const headings = Number(process.argv[2] ?? 200);
const linesPerSection = Number(process.argv[3] ?? 10);

function generate() {
  const out = [];
  const levels = [1, 2, 3, 3, 4, 2, 4, 3]; // includes a 2 -> 4 skip
  for (let i = 0; i < headings; i++) {
    out.push(`${"#".repeat(levels[i % levels.length])} Task ${i}: **refactor** the \`thing\` [link](https://x.y)`);
    out.push("");
    for (let j = 0; j < linesPerSection; j++) {
      out.push(j % 3 === 0 ? `- [ ] subtask ${j} with some text that runs on a while` : `Body line ${j} of section ${i}, ordinary prose.`);
    }
    if (i % 10 === 0) {
      out.push("```bash", "# comment that is not a heading", "## neither is this", "```");
    }
    out.push("");
  }
  return out.join("\n");
}

const doc = generate();
const lineCount = doc.split("\n").length;

// Warm up the JIT, then time many runs and report percentiles.
for (let i = 0; i < 200; i++) { parseMarkdownHeadings(doc, 6); }
const samples = [];
for (let i = 0; i < 2000; i++) {
  const t0 = performance.now();
  parseMarkdownHeadings(doc, 6);
  samples.push(performance.now() - t0);
}
samples.sort((a, b) => a - b);
const pct = p => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))].toFixed(3);

const tree = parseMarkdownHeadings(doc, 6);
let count = 0;
const walk = nodes => { for (const n of nodes) { count++; walk(n.children); } };
walk(tree);

console.log(`doc: ${headings} headings, ${lineCount} lines, ${(doc.length / 1024).toFixed(1)} KiB; parsed ${count} headings`);
console.log(`parse ms  median ${pct(0.5)}  p95 ${pct(0.95)}  p99 ${pct(0.99)}  max ${samples[samples.length - 1].toFixed(3)}`);
