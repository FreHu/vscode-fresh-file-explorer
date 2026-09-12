// Probe: how well do the co-change join keys work on real multi-repo history?
//
// Measures, for two or more repos:
//   - ticket-id coverage per repo (ClickUp-style ids + clickup.com URLs)
//   - cross-repo joins by ticket id
//   - cross-repo joins by rare normalized message (rarity-damped)
//   - cross-repo joins by author + time-window session
//
// Usage: node scripts/probes/cochangeJoinKeys.mjs <repoA> <repoB> [--since "12 months ago"] [--session-mins 120]
// Prints a summary to stdout; writes nothing (probe data may be private repo history).

import { execFileSync } from "node:child_process";
import path from "node:path";

const args = process.argv.slice(2);
const repos = args.filter(a => !a.startsWith("--") && !isFlagValue(args, a));
const since = flag("--since") ?? "12 months ago";
const sessionMins = Number(flag("--session-mins") ?? 120);

function flag(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}
function isFlagValue(all, a) {
  const i = all.indexOf(a);
  return i > 0 && all[i - 1].startsWith("--");
}

if (repos.length < 2) {
  console.error("need at least two repo paths");
  process.exit(1);
}

// ClickUp task ids: 86 + 7..10 base36 chars, standalone token or in a /t/ URL.
const TICKET_RE = /\b(86[0-9a-z]{7,10})\b/gi;

function extractTickets(subject) {
  return [...subject.matchAll(TICKET_RE)].map(m => m[1].toLowerCase());
}

/** Strip join-noise so identical work descriptions compare equal across repos. */
function normalizeMessage(subject) {
  return subject
    .toLowerCase()
    .replace(TICKET_RE, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^merged pr \d+:?\s*/i, "")
    .replace(/[-–—:#[\]()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isMergeNoise(subject) {
  return /^merge (branch|remote)/i.test(subject);
}

function loadCommits(repo) {
  const out = execFileSync(
    "git",
    ["log", "--no-merges", `--since=${since}`, "--format=%H%x1f%an%x1f%at%x1f%s"],
    { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split("\n")
    .filter(Boolean)
    .map(line => {
      const [hash, author, at, subject] = line.split("\x1f");
      return { repo: path.basename(repo), hash, author, at: Number(at) * 1000, subject };
    })
    .filter(c => !isMergeNoise(c.subject));
}

const byRepo = new Map(repos.map(r => [path.basename(r), loadCommits(r)]));
const all = [...byRepo.values()].flat();

console.log(`window: --since "${since}"`);
for (const [name, commits] of byRepo) {
  const withTicket = commits.filter(c => extractTickets(c.subject).length > 0);
  console.log(`${name}: ${commits.length} commits (merges excluded), ${withTicket.length} with ticket id (${pct(withTicket.length, commits.length)})`);
}

// ── join 1: ticket id ───────────────────────────────────────────────────────
const ticketRepos = new Map(); // ticket -> Map(repo -> count)
for (const c of all) {
  for (const t of new Set(extractTickets(c.subject))) {
    const m = ticketRepos.get(t) ?? new Map();
    m.set(c.repo, (m.get(c.repo) ?? 0) + 1);
    ticketRepos.set(t, m);
  }
}
const crossTickets = [...ticketRepos.entries()].filter(([, m]) => m.size >= 2);
console.log(`\nticket join: ${ticketRepos.size} distinct ids, ${crossTickets.length} span repos (${pct(crossTickets.length, ticketRepos.size)})`);
const crossTicketCommits = crossTickets.reduce((n, [, m]) => n + [...m.values()].reduce((a, b) => a + b, 0), 0);
console.log(`  commits joined into cross-repo work units: ${crossTicketCommits}`);
for (const [t, m] of crossTickets.slice(0, 5)) {
  console.log(`  e.g. ${t}: ${[...m.entries()].map(([r, n]) => `${r}×${n}`).join(", ")}`);
}

// ── join 2: rare normalized message ─────────────────────────────────────────
const msgOccurrences = new Map(); // normalized msg -> commits
for (const c of all) {
  const norm = normalizeMessage(c.subject);
  if (norm.split(" ").length < 3) continue; // too short to be distinctive
  (msgOccurrences.get(norm) ?? msgOccurrences.set(norm, []).get(norm)).push(c);
}
const RARITY_CAP = 4; // a message this common is a stop-message, not a key
const msgJoins = [...msgOccurrences.entries()].filter(([, cs]) =>
  cs.length >= 2 && cs.length <= RARITY_CAP && new Set(cs.map(c => c.repo)).size >= 2,
);
// Exclude pairs already joined by ticket so we measure *additional* coverage.
const ticketJoinedHashes = new Set(
  all.filter(c => extractTickets(c.subject).some(t => ticketRepos.get(t)?.size >= 2)).map(c => c.hash),
);
const msgJoinsNew = msgJoins.filter(([, cs]) => cs.some(c => !ticketJoinedHashes.has(c.hash)));
console.log(`\nmessage join (≥3 words, ≤${RARITY_CAP} occurrences): ${msgJoins.length} cross-repo message groups, ${msgJoinsNew.length} not already ticket-joined`);
for (const [msg, cs] of msgJoinsNew.slice(0, 5)) {
  console.log(`  e.g. "${msg.slice(0, 70)}" (${cs.map(c => c.repo).join("+")})`);
}

// ── join 3: author + time-window session ────────────────────────────────────
const sessionMs = sessionMins * 60 * 1000;
const byAuthor = new Map();
for (const c of all) {
  (byAuthor.get(c.author) ?? byAuthor.set(c.author, []).get(c.author)).push(c);
}
let crossSessions = 0;
let sessionJoinedCommits = 0;
let sessionOnlyCommits = 0;
for (const commits of byAuthor.values()) {
  commits.sort((a, b) => a.at - b.at);
  let session = [];
  const flush = () => {
    if (new Set(session.map(c => c.repo)).size >= 2) {
      crossSessions++;
      sessionJoinedCommits += session.length;
      sessionOnlyCommits += session.filter(c => !ticketJoinedHashes.has(c.hash)).length;
    }
    session = [];
  };
  for (const c of commits) {
    if (session.length > 0 && c.at - session[session.length - 1].at > sessionMs) flush();
    session.push(c);
  }
  flush();
}
console.log(`\nsession join (author + ${sessionMins}min gap): ${crossSessions} cross-repo sessions, ${sessionJoinedCommits} commits inside them (${sessionOnlyCommits} not already ticket-joined)`);

function pct(a, b) {
  return b === 0 ? "n/a" : `${((100 * a) / b).toFixed(0)}%`;
}
