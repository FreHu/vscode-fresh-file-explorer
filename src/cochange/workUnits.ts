/**
 * Cross-repo work units, joined by ticket ids in commit messages.
 *
 * Two repos share no commits, but they do share tickets: "869eh92ff - expose
 * attachments" in the api and "869eh92ff - show attachments" in the ui are one
 * unit of work. Grouping commits by ticket id yields pseudo-commits that span
 * repos, and repo-presence statistics over them answer the question file-level
 * mining cannot: "tickets touching this area usually also change the other
 * repo — which has no pending changes."
 *
 * Confidence is computed against ALL ticketed units containing the
 * conditioning item — not just cross-repo ones — and must clear a lift over
 * the base rate P(other repo | any unit from this repo), so a workspace where
 * most tickets span repos anyway produces no nudges from that fact alone.
 *
 * Pure and vscode-free.
 */

import { parentDir } from "./cochangeEngine";

/** One commit with enough context to join and aggregate. */
export interface TicketCommit {
  /** Stable repo key (normalized full path); display naming is the caller's concern. */
  repo: string;
  /** Normalized repo-relative file paths. */
  files: string[];
  message: string;
  /** Commit time (ms since epoch). */
  at?: number;
}

/** Commits across repos that share one ticket id. */
export interface WorkUnit {
  ticket: string;
  filesByRepo: Map<string, string[]>;
  /** Latest commit time in the unit (ms), when timestamps are present. */
  at?: number;
}

/**
 * Built-in ticket-id shapes:
 *  - JIRA / Linear / YouTrack-style keys (AB-123)
 *  - ClickUp task ids (86 + base36 tail, bare or inside clickup.com URLs)
 *  - Azure Boards work-item references (AB#123 — ids are organization-wide)
 *  - Shortcut story references (sc-123)
 *
 * Deliberately NOT `#123` — issue/PR numbers are per-repo, so equal numbers
 * across repos would join unrelated work.
 */
const BUILT_IN_TICKET_PATTERNS: RegExp[] = [
  // The (?:-\d+)* tail keeps multi-segment ids (CVE-2026-12345) whole — a
  // truncated "cve-2026" would join every CVE of a year.
  /\b[A-Z][A-Z0-9]+-\d+(?:-\d+)*\b/g,
  /\b86[0-9a-z]{7,10}\b/gi,
  /\bAB#\d+\b/gi,
  /\bsc-\d+\b/gi,
];

/**
 * Technical tokens the JIRA-style shape false-matches. Joining on these would
 * unite unrelated commits that merely mention the same standard ("support
 * UTF-8 filenames" in two repos is not one ticket). CVE ids are deliberately
 * NOT here — patching the same CVE in two repos is plausibly one unit of work.
 */
const TICKET_STOPLIST_PREFIXES = new Set(["utf", "sha", "iso", "rfc", "md", "aes", "es", "http", "tls", "ip"]);

function isStoplisted(id: string): boolean {
  const dash = id.indexOf("-");
  return dash > 0 && TICKET_STOPLIST_PREFIXES.has(id.substring(0, dash));
}

/** Ticket ids found anywhere in a commit message (subject or body), lowercased for joining. */
export function extractTicketIds(message: string, extraPattern?: RegExp): string[] {
  const ids = new Set<string>();
  for (const pattern of BUILT_IN_TICKET_PATTERNS) {
    for (const m of message.matchAll(pattern)) {
      const id = m[0].toLowerCase();
      if (!isStoplisted(id)) { ids.add(id); }
    }
  }
  // A user-supplied pattern is trusted verbatim — no stoplist second-guessing.
  if (extraPattern) {
    for (const m of message.matchAll(extraPattern)) {
      ids.add(m[0].toLowerCase());
    }
  }
  return [...ids];
}

/** Group commits by ticket id. A commit with several ids joins several units. */
export function buildWorkUnits(commits: TicketCommit[], extraPattern?: RegExp): WorkUnit[] {
  const units = new Map<string, WorkUnit>();
  for (const c of commits) {
    for (const ticket of extractTicketIds(c.message, extraPattern)) {
      let unit = units.get(ticket);
      if (!unit) {
        unit = { ticket, filesByRepo: new Map() };
        units.set(ticket, unit);
      }
      const files = unit.filesByRepo.get(c.repo) ?? [];
      files.push(...c.files);
      unit.filesByRepo.set(c.repo, files);
      if (c.at !== undefined && (unit.at === undefined || c.at > unit.at)) {
        unit.at = c.at;
      }
    }
  }
  return [...units.values()];
}

export interface CrossRepoNudge {
  sourceRepo: string;
  /** The conditioning item (file or its parent dir) with the strongest evidence. */
  source: string;
  sourceKind: "file" | "dir";
  targetRepo: string;
  /** Units containing the source item that also touched the target repo. */
  together: number;
  /** Units containing the source item at all. */
  total: number;
  confidence: number;
  /** P(target repo | any unit touching the source repo) — what the nudge had to beat. */
  baseRate: number;
  lastTogetherAt?: number;
}

export interface CrossRepoOptions {
  minSupport?: number;
  minConfidence?: number;
  /** Confidence must exceed baseRate by this factor, or the nudge is just the base rate restated. */
  minLift?: number;
  /** Drop couplings whose last shared unit is older than this (ms since epoch). */
  minLastTogetherAt?: number;
  onStats?: (stats: CrossRepoStats) => void;
}

export interface CrossRepoStats {
  units: number;
  unitsWithSourceRepo: number;
  /** Per target repo: base rate over units touching the source repo. */
  baseRates: Record<string, number>;
  considered: number;
  kept: number;
}

const CROSS_DEFAULTS: Required<Pick<CrossRepoOptions, "minSupport" | "minConfidence" | "minLift">> = {
  minSupport: 3,
  minConfidence: 0.6,
  minLift: 1.5,
};

/**
 * For each other repo, the strongest "tickets touching X here usually also
 * change that repo" statement the units support — at most one nudge per
 * target repo, or none when nothing clears support, confidence, lift and
 * liveness.
 */
export function computeCrossRepoPresence(
  units: WorkUnit[],
  seed: { repo: string; files: string[] },
  options: CrossRepoOptions = {},
): CrossRepoNudge[] {
  const opts = { ...CROSS_DEFAULTS, ...options };

  // Seed items: the changed files and their parent dirs, matched against the
  // same shapes inside units.
  const seedItems = new Map<string, { path: string; kind: "file" | "dir" }>();
  for (const f of seed.files) {
    seedItems.set("file:" + f, { path: f, kind: "file" });
    const dir = parentDir(f);
    if (dir !== undefined) { seedItems.set("dir:" + dir, { path: dir, kind: "dir" }); }
  }

  const stats: CrossRepoStats = { units: units.length, unitsWithSourceRepo: 0, baseRates: {}, considered: 0, kept: 0 };

  // item key -> per-target evidence
  const evidence = new Map<string, { item: { path: string; kind: "file" | "dir" }; total: number; byTarget: Map<string, { together: number; lastTogetherAt?: number }> }>();
  const targetRepoUnitCounts = new Map<string, number>(); // target repo -> units shared with source repo

  for (const unit of units) {
    const sourceFiles = unit.filesByRepo.get(seed.repo);
    if (!sourceFiles) { continue; }
    stats.unitsWithSourceRepo++;

    const otherRepos = [...unit.filesByRepo.keys()].filter(r => r !== seed.repo);
    for (const r of otherRepos) {
      targetRepoUnitCounts.set(r, (targetRepoUnitCounts.get(r) ?? 0) + 1);
    }

    // Which seed items does this unit touch?
    const unitItemKeys = new Set<string>();
    for (const f of sourceFiles) {
      unitItemKeys.add("file:" + f);
      const dir = parentDir(f);
      if (dir !== undefined) { unitItemKeys.add("dir:" + dir); }
    }
    for (const key of unitItemKeys) {
      const item = seedItems.get(key);
      if (!item) { continue; }
      let entry = evidence.get(key);
      if (!entry) {
        entry = { item, total: 0, byTarget: new Map() };
        evidence.set(key, entry);
      }
      entry.total++;
      for (const r of otherRepos) {
        const t = entry.byTarget.get(r) ?? { together: 0 };
        t.together++;
        if (unit.at !== undefined && (t.lastTogetherAt === undefined || unit.at > t.lastTogetherAt)) {
          t.lastTogetherAt = unit.at;
        }
        entry.byTarget.set(r, t);
      }
    }
  }

  for (const [r, n] of targetRepoUnitCounts) {
    stats.baseRates[r] = stats.unitsWithSourceRepo > 0 ? n / stats.unitsWithSourceRepo : 0;
  }

  // Best qualifying nudge per target repo.
  const bestByTarget = new Map<string, CrossRepoNudge>();
  for (const { item, total, byTarget } of evidence.values()) {
    for (const [targetRepo, { together, lastTogetherAt }] of byTarget) {
      stats.considered++;
      if (together < opts.minSupport) { continue; }
      const confidence = together / total;
      if (confidence < opts.minConfidence) { continue; }
      const baseRate = stats.baseRates[targetRepo] ?? 0;
      if (confidence < baseRate * opts.minLift) { continue; }
      if (opts.minLastTogetherAt !== undefined && lastTogetherAt !== undefined && lastTogetherAt < opts.minLastTogetherAt) { continue; }

      const nudge: CrossRepoNudge = {
        sourceRepo: seed.repo,
        source: item.path,
        sourceKind: item.kind,
        targetRepo,
        together,
        total,
        confidence,
        baseRate,
        lastTogetherAt,
      };
      const current = bestByTarget.get(targetRepo);
      if (
        !current
        || nudge.confidence > current.confidence
        || (nudge.confidence === current.confidence && nudge.together > current.together)
        || (nudge.confidence === current.confidence && nudge.together === current.together && nudge.sourceKind === "file" && current.sourceKind === "dir")
      ) {
        bestByTarget.set(targetRepo, nudge);
      }
    }
  }

  const kept = [...bestByTarget.values()].sort((a, b) =>
    b.confidence - a.confidence || b.together - a.together || a.targetRepo.localeCompare(b.targetRepo),
  );
  stats.kept = kept.length;
  options.onStats?.(stats);
  return kept;
}
