// Probe: given the join keys work, is the resulting co-change signal usable?
//
//   1. single-repo: top file→file associations by confidence (the "forgotten
//      file" suggestion the feature would actually emit)
//   2. cross-repo: ticket-joined work units → directory→directory associations
//
// Usage: node scripts/probes/cochangeSignal.mjs <repoA> [repoB] [--since "12 months ago"]
// Prints to stdout; writes nothing (probe data may be private repo history).

import { execFileSync } from "node:child_process";
import path from "node:path";

const args = process.argv.slice(2);
const repos = args.filter(a => !a.startsWith("--") && !isFlagValue(args, a));
const since = flag("--since") ?? "12 months ago";

function flag(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}
function isFlagValue(all, a) {
  const i = all.indexOf(a);
  return i > 0 && all[i - 1].startsWith("--");
}

const TICKET_RE = /\b(86[0-9a-z]{7,10})\b/gi;

function loadCommitsWithFiles(repo) {
  const out = execFileSync(
    "git",
    ["log", "--no-merges", `--since=${since}`, "--name-only", "--format=%x01%H%x1f%s"],
    { cwd: repo, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const commits = [];
  for (const block of out.split("\x01").filter(Boolean)) {
    const [header, ...rest] = block.split("\n");
    const [hash, subject] = header.split("\x1f");
    const files = rest.filter(Boolean);
    commits.push({ repo: path.basename(repo), hash, subject, files });
  }
  return commits;
}

// ── 1. single-repo file→file confidence ─────────────────────────────────────
const MAX_COMMIT_FILES = 30;   // bulk commits (renames, formatting) are noise
const PROMISCUITY_CAP = 0.15;  // file in >15% of commits co-changes with everything
const MIN_SUPPORT = 3;
const MIN_CONFIDENCE = 0.5;

function singleRepoReport(commits) {
  const usable = commits.filter(c => c.files.length >= 2 && c.files.length <= MAX_COMMIT_FILES);
  const fileCommits = new Map(); // file -> Set(commit hash)
  for (const c of usable) {
    for (const f of c.files) {
      (fileCommits.get(f) ?? fileCommits.set(f, new Set()).get(f)).add(c.hash);
    }
  }
  const ubiquitous = new Set(
    [...fileCommits.entries()].filter(([, s]) => s.size / usable.length > PROMISCUITY_CAP).map(([f]) => f),
  );

  const pairCounts = new Map(); // "a\x1fb" -> count (directed a→b)
  for (const c of usable) {
    const files = c.files.filter(f => !ubiquitous.has(f));
    for (const a of files) {
      for (const b of files) {
        if (a === b) continue;
        const key = a + "\x1f" + b;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const suggestions = [];
  for (const [key, together] of pairCounts) {
    const [a, b] = key.split("\x1f");
    const aTotal = fileCommits.get(a).size;
    if (together < MIN_SUPPORT) continue;
    const confidence = together / aTotal;
    if (confidence < MIN_CONFIDENCE) continue;
    suggestions.push({ a, b, together, aTotal, confidence });
  }
  suggestions.sort((x, y) => y.confidence - x.confidence || y.together - x.together);
  return { usable: usable.length, ubiquitous: [...ubiquitous], suggestions };
}

// ── 2. cross-repo dir→dir via ticket-joined work units ──────────────────────
function topDir(file, depth = Number(flag("--depth") ?? 2)) {
  const parts = file.split("/");
  return parts.slice(0, Math.min(depth, parts.length - 1)).join("/") || "(root)";
}

function crossRepoReport(all) {
  const units = new Map(); // ticket -> commits
  for (const c of all) {
    for (const t of new Set([...c.subject.matchAll(TICKET_RE)].map(m => m[1].toLowerCase()))) {
      (units.get(t) ?? units.set(t, []).get(t)).push(c);
    }
  }
  const crossUnits = [...units.values()].filter(cs => new Set(cs.map(c => c.repo)).size >= 2);

  const pairCounts = new Map(); // "repoA:dir -> repoB:dir" unit counts
  const dirUnitCounts = new Map(); // "repo:dir" -> units it appears in
  for (const cs of crossUnits) {
    const dirs = new Set(cs.flatMap(c => c.files.map(f => `${c.repo}:${topDir(f)}`)));
    for (const d of dirs) {
      dirUnitCounts.set(d, (dirUnitCounts.get(d) ?? 0) + 1);
    }
    for (const a of dirs) {
      for (const b of dirs) {
        if (a.split(":")[0] === b.split(":")[0]) continue; // cross-repo pairs only
        const key = a + " -> " + b;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const pairs = [...pairCounts.entries()]
    .map(([key, n]) => ({ key, n, of: dirUnitCounts.get(key.split(" -> ")[0]) }))
    .filter(p => p.n >= 3)
    .sort((x, y) => y.n - x.n);
  return { crossUnits: crossUnits.length, pairs };
}

// ── run ──────────────────────────────────────────────────────────────────────
const perRepo = repos.map(r => ({ name: path.basename(r), commits: loadCommitsWithFiles(r) }));

for (const { name, commits } of perRepo) {
  const rep = singleRepoReport(commits);
  console.log(`\n=== ${name}: single-repo file→file (support≥${MIN_SUPPORT}, confidence≥${MIN_CONFIDENCE}) ===`);
  console.log(`usable commits: ${rep.usable}; ubiquitous files excluded: ${rep.ubiquitous.length}`);
  for (const f of rep.ubiquitous.slice(0, 5)) console.log(`  ubiquitous: ${f}`);
  console.log(`suggestion pairs: ${rep.suggestions.length}`);
  for (const s of rep.suggestions.slice(0, 12)) {
    console.log(`  ${(s.confidence * 100).toFixed(0)}% (${s.together}/${s.aTotal})  ${s.a}  →  ${s.b}`);
  }
}

if (perRepo.length >= 2) {
  const rep = crossRepoReport(perRepo.flatMap(r => r.commits));
  console.log(`\n=== cross-repo dir→dir via ticket joins (unit count ≥3) ===`);
  console.log(`cross-repo work units: ${rep.crossUnits}`);
  for (const p of rep.pairs.slice(0, 15)) {
    console.log(`  ${p.n}/${p.of} units  ${p.key}`);
  }
}
