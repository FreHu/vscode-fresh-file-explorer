/**
 * Co-change suggestion engine ("forgotten file" hints).
 *
 * Given a repo's recent commit history (which files changed together) and the
 * current pending files, ranks files/directories that usually accompany the
 * pending changes but are untouched — e.g. an interface next to its
 * implementation, or a migrations directory next to an entity edit.
 *
 * Associations are computed at mixed granularity on both sides: specific
 * file→file pairs where per-file evidence clears the support floor, pooled
 * dir→file / file→dir / dir→dir associations where it doesn't (individual
 * entity files change rarely; one-shot files like DB migrations never repeat).
 * The finest qualifying variant wins; coarser duplicates are suppressed.
 *
 * Pure and vscode-free: paths in, suggestions out. All thresholds are
 * explicit so the honesty rule holds — below the evidence floor the engine
 * returns nothing rather than guessing.
 */

export interface CochangeCommit {
  /** Normalized repo-relative file paths (forward slashes). */
  files: string[];
  /** Commit time (ms since epoch). Enables the liveness filter and evidence dates. */
  at?: number;
  /** Full commit message (subject + body) — unused here, consumed by the cross-repo ticket join. */
  message?: string;
}

export interface CochangeOptions {
  /** Commits touching more files than this are bulk noise (renames, formatting). */
  maxCommitFiles?: number;
  /** A file in more than this fraction of commits co-changes with everything. */
  fileUbiquityCap?: number;
  /** Same idea for directories — looser, a busy directory is still a real unit. */
  dirUbiquityCap?: number;
  /** Minimum co-change commits before a pair is evidence rather than noise. */
  minSupport?: number;
  /** Minimum P(target | source). */
  minConfidence?: number;
  /** At most this many suggestions, best first. */
  maxSuggestions?: number;
  /**
   * Drop pairs whose last co-change is older than this (ms since epoch) — a
   * coupling that died in a refactor keeps its historical counts but is no
   * longer advice. Only applies to commits that carry timestamps.
   */
  minLastTogetherAt?: number;
  /**
   * Files that count as already-handled targets beyond `pendingFiles` itself.
   * Used when suggesting from a single seed file: the seed drives the
   * associations, but everything already pending is not "forgotten".
   */
  satisfiedFiles?: string[];
  /** Receives the run's filtering funnel, for diagnostics/logging. */
  onStats?: (stats: CochangeStats) => void;
}

/** How a run arrived at its results — every stage of the filtering funnel. */
export interface CochangeStats {
  historyCommits: number;
  /** Commits inside the 2..maxCommitFiles size band. */
  usableCommits: number;
  /** Items (files + dirs) excluded for co-changing with everything. */
  ubiquitousItems: number;
  /** Distinct source→target pairs observed for the seed items. */
  pairsObserved: number;
  belowSupport: number;
  droppedAsStale: number;
  belowConfidence: number;
  alreadySatisfied: number;
  /** Candidates surviving all filters, before granularity subsumption + cap. */
  candidates: number;
  kept: number;
}

export type CochangeItemKind = "file" | "dir";

export interface CochangeSuggestion {
  /** The path being suggested (untouched, usually changes along). */
  target: string;
  targetKind: CochangeItemKind;
  /** The pending path that provides the evidence. */
  source: string;
  sourceKind: CochangeItemKind;
  /** Commits where source and target changed together. */
  together: number;
  /** Commits where source changed at all. */
  total: number;
  /** together / total. */
  confidence: number;
  /** When source and target last changed together (ms), if history carried timestamps. */
  lastTogetherAt?: number;
}

const DEFAULTS: Required<Omit<CochangeOptions, "minLastTogetherAt" | "satisfiedFiles" | "onStats">> = {
  maxCommitFiles: 30,
  fileUbiquityCap: 0.15,
  dirUbiquityCap: 0.5,
  minSupport: 3,
  minConfidence: 0.5,
  maxSuggestions: 8,
};

/** Immediate parent directory, or undefined at the repo root (too broad to be a unit). */
export function parentDir(file: string): string | undefined {
  const idx = file.lastIndexOf("/");
  return idx > 0 ? file.substring(0, idx) : undefined;
}

function isWithin(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + "/");
}

/** Trivial containment (a file and its own ancestor dir) is correlation by construction. */
function related(a: string, b: string): boolean {
  return isWithin(a, b) || isWithin(b, a);
}

interface Item {
  path: string;
  kind: CochangeItemKind;
}

/** The one key format used across every map in this module. */
function itemKey(kind: CochangeItemKind, path: string): string {
  return kind + ":" + path;
}

/** Distinct items (files + their parent dirs) for one commit. */
function commitItems(files: string[]): Item[] {
  const items = new Map<string, Item>();
  for (const f of files) {
    items.set(itemKey("file", f), { path: f, kind: "file" });
    const dir = parentDir(f);
    if (dir !== undefined) {
      items.set(itemKey("dir", dir), { path: dir, kind: "dir" });
    }
  }
  return [...items.values()];
}

/** Rank finer granularity first: file→file, then mixed, then dir→dir. */
function granularityRank(s: { sourceKind: CochangeItemKind; targetKind: CochangeItemKind }): number {
  return (s.sourceKind === "dir" ? 1 : 0) + (s.targetKind === "dir" ? 1 : 0);
}

export function computeCochangeSuggestions(
  history: CochangeCommit[],
  pendingFiles: string[],
  options: CochangeOptions = {},
): CochangeSuggestion[] {
  const opts = { ...DEFAULTS, ...options };

  const stats: CochangeStats = {
    historyCommits: history.length,
    usableCommits: 0,
    ubiquitousItems: 0,
    pairsObserved: 0,
    belowSupport: 0,
    droppedAsStale: 0,
    belowConfidence: 0,
    alreadySatisfied: 0,
    candidates: 0,
    kept: 0,
  };

  const usable = history.filter(c => c.files.length >= 2 && c.files.length <= opts.maxCommitFiles);
  stats.usableCommits = usable.length;
  if (usable.length === 0 || pendingFiles.length === 0) {
    options.onStats?.(stats);
    return [];
  }

  // Occurrence counts per item across usable commits.
  const occurrences = new Map<string, { item: Item; count: number }>();
  const perCommitItems: Item[][] = [];
  for (const c of usable) {
    const items = commitItems(c.files);
    perCommitItems.push(items);
    for (const item of items) {
      const key = itemKey(item.kind, item.path);
      const entry = occurrences.get(key);
      if (entry) { entry.count++; } else { occurrences.set(key, { item, count: 1 }); }
    }
  }

  const ubiquitous = new Set<string>();
  for (const [key, { item, count }] of occurrences) {
    const cap = item.kind === "file" ? opts.fileUbiquityCap : opts.dirUbiquityCap;
    // The fraction alone misfires on short histories (in 6 commits, 100% is
    // not evidence of anything) — demand an absolute count too before calling
    // an item ubiquitous.
    if (count > Math.max(cap * usable.length, 2 * opts.minSupport)) {
      ubiquitous.add(key);
    }
  }

  // Only pairs whose source side is pending matter — restrict counting to them.
  const pendingItemKeys = new Set<string>();
  for (const f of pendingFiles) {
    pendingItemKeys.add(itemKey("file", f));
    const dir = parentDir(f);
    if (dir !== undefined) { pendingItemKeys.add(itemKey("dir", dir)); }
  }

  const pairCounts = new Map<string, { source: Item; target: Item; together: number; lastTogetherAt?: number }>();
  for (let ci = 0; ci < perCommitItems.length; ci++) {
    const items = perCommitItems[ci];
    const at = usable[ci].at;
    for (const source of items) {
      const sourceKey = itemKey(source.kind, source.path);
      if (!pendingItemKeys.has(sourceKey) || ubiquitous.has(sourceKey)) { continue; }
      for (const target of items) {
        const targetKey = itemKey(target.kind, target.path);
        if (targetKey === sourceKey || ubiquitous.has(targetKey)) { continue; }
        if (related(source.path, target.path)) { continue; }
        const pairKey = sourceKey + "\x1f" + targetKey;
        const entry = pairCounts.get(pairKey);
        if (entry) {
          entry.together++;
          if (at !== undefined && (entry.lastTogetherAt === undefined || at > entry.lastTogetherAt)) {
            entry.lastTogetherAt = at;
          }
        } else {
          pairCounts.set(pairKey, { source, target, together: 1, lastTogetherAt: at });
        }
      }
    }
  }

  // A target is satisfied when it's already part of the current change.
  const satisfiedFiles = [...pendingFiles, ...(opts.satisfiedFiles ?? [])];
  const satisfiedSet = new Set(satisfiedFiles);
  const targetSatisfied = (target: Item): boolean =>
    target.kind === "file"
      ? satisfiedSet.has(target.path)
      : satisfiedFiles.some(f => isWithin(f, target.path));

  stats.ubiquitousItems = ubiquitous.size;
  stats.pairsObserved = pairCounts.size;

  const candidates: CochangeSuggestion[] = [];
  for (const { source, target, together, lastTogetherAt } of pairCounts.values()) {
    if (together < opts.minSupport) { stats.belowSupport++; continue; }
    // Liveness: a coupling that stopped co-changing is history, not advice.
    if (opts.minLastTogetherAt !== undefined && lastTogetherAt !== undefined && lastTogetherAt < opts.minLastTogetherAt) { stats.droppedAsStale++; continue; }
    const total = occurrences.get(itemKey(source.kind, source.path))!.count;
    const confidence = together / total;
    if (confidence < opts.minConfidence) { stats.belowConfidence++; continue; }
    if (targetSatisfied(target)) { stats.alreadySatisfied++; continue; }
    candidates.push({
      target: target.path,
      targetKind: target.kind,
      source: source.path,
      sourceKind: source.kind,
      together,
      total,
      confidence,
      lastTogetherAt,
    });
  }

  // Finest granularity first; within a rank, strongest evidence first.
  candidates.sort((a, b) =>
    granularityRank(a) - granularityRank(b)
    || b.confidence - a.confidence
    || b.together - a.together
    || a.target.localeCompare(b.target),
  );

  // Keep one suggestion per effective target: a finer/stronger suggestion
  // subsumes coarser ones for the same file, its parent dir, or dirs already
  // suggested (a file target inside an already-suggested dir adds nothing,
  // and vice versa).
  const kept: CochangeSuggestion[] = [];
  for (const c of candidates) {
    if (kept.some(k => related(k.target, c.target))) { continue; }
    kept.push(c);
    if (kept.length >= opts.maxSuggestions) { break; }
  }

  stats.candidates = candidates.length;
  stats.kept = kept.length;
  options.onStats?.(stats);
  return kept;
}
