import { AbsolutePath, parentDir } from "../pathTypes";
import { FileMetadata } from "../types";
import { sortDateOf } from "../utils/changeDate";

export interface DirStats {
  count: number;
  mostRecent: Date | undefined;
  linesAdded: number;
  linesDeleted: number;
}

/**
 * Two-level performance structure over a flat Map<AbsolutePath, FileMetadata>:
 *
 * 1. **Path index** — normalized parent path → set of normalized direct child paths
 *    (both files and intermediate directories). Rebuilt on every file-map change via
 *    `rebuild()`. Turns O(n) buildTree directory scans into O(children).
 *
 * 2. **Dir-stats cache** — normalized dir path → {count, mostRecent, lines}.
 *    Built lazily in a single O(n) pass the first time `ensureDirStats()` is called
 *    after a rebuild or `invalidateStats()`. Propagates each file's contribution up
 *    every ancestor directory so all callers share one pass per render cycle.
 */
export class FileIndex {
  private pathIndex: Map<AbsolutePath, Set<AbsolutePath>> = new Map();
  private dirStatsCache: Map<AbsolutePath, DirStats> | null = null;

  /**
   * Rebuild the path index from a new file map and invalidate the stats cache.
   * Must be called whenever the canonical file map changes.
   */
  rebuild(files: Map<AbsolutePath, FileMetadata>): void {
    const index = new Map<AbsolutePath, Set<AbsolutePath>>();

    for (const filePath of files.keys()) {
      // Register the file in its immediate parent.
      const immediateParent = parentDir(filePath);
      if (immediateParent === undefined) { continue; }
      if (!index.has(immediateParent)) { index.set(immediateParent, new Set()); }
      index.get(immediateParent)!.add(filePath);

      // Walk up the chain, registering each dir in its parent.
      // Stop as soon as an ancestor is already present (all higher ones are done too).
      let child = immediateParent;
      for (let parent = parentDir(child); parent !== undefined; parent = parentDir(child)) {
        if (!index.has(parent)) { index.set(parent, new Set()); }
        const parentSet = index.get(parent)!;
        if (parentSet.has(child)) { break; }
        parentSet.add(child);
        child = parent;
      }
    }

    this.pathIndex = index;
    this.dirStatsCache = null;
  }

  /**
   * Invalidate the dir-stats cache without rebuilding the path index.
   * Call this when filters or scopes change so the next `ensureDirStats()` call
   * recomputes stats with the updated predicates.
   */
  invalidateStats(): void {
    this.dirStatsCache = null;
  }

  /** Return the direct children (files + sub-directories) of `normalizedPath`, or `undefined` if none. */
  getDirectChildren(normalizedPath: AbsolutePath): Set<AbsolutePath> | undefined {
    return this.pathIndex.get(normalizedPath);
  }

  /**
   * Return (building lazily) per-render directory stats that respect the current
   * filter and scope predicates. The result is cached until `rebuild()` or
   * `invalidateStats()` is called.
   *
   * @param files         The canonical file map (same instance passed to the last `rebuild()`).
   * @param passesFilters Returns true if a file should be counted (author/commit filters).
   * @param passesScope   Returns true if a file is within the active folder scope.
   * @param showLineChanges Whether to accumulate linesAdded/linesDeleted.
   */
  ensureDirStats(
    files: Map<AbsolutePath, FileMetadata>,
    passesFilters: (metadata: FileMetadata) => boolean,
    passesScope: (normalizedPath: AbsolutePath) => boolean,
    showLineChanges: boolean,
  ): Map<AbsolutePath, DirStats> {
    if (this.dirStatsCache) { return this.dirStatsCache; }

    const cache = new Map<AbsolutePath, DirStats>();

    for (const [filePath, metadata] of files) {
      if (!passesFilters(metadata)) { continue; }
      const normalizedFile = filePath;
      if (!passesScope(normalizedFile)) { continue; }

      // Propagate this file's contribution up every ancestor directory.
      for (let dir = parentDir(normalizedFile); dir !== undefined; dir = parentDir(dir)) {
        let stats = cache.get(dir);
        if (!stats) {
          stats = { count: 0, mostRecent: undefined, linesAdded: 0, linesDeleted: 0 };
          cache.set(dir, stats);
        }
        stats.count++;
        const date = sortDateOf(metadata);
        if (date && (!stats.mostRecent || date > stats.mostRecent)) { stats.mostRecent = date; }
        if (showLineChanges) {
          stats.linesAdded += metadata.linesAdded ?? 0;
          stats.linesDeleted += metadata.linesDeleted ?? 0;
        }
      }
    }

    this.dirStatsCache = cache;
    return cache;
  }
}
