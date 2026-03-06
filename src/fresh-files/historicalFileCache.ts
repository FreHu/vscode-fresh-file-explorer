import * as path from "path";
import * as v8 from "v8";

import { AbsolutePath, NormalizedRepoPath } from "../pathTypes";
import { FileMetadata, WorkspaceFolderInfo } from "../types";
import { normalizePath } from "../utils";

export interface CacheRepoStats {
  repoLabel: string;
  repoPath: string;
  entryCount: number;
  sizeBytes: number;
}

interface CacheEntry {
  data: Map<AbsolutePath, FileMetadata>;
  /** Sorted ascending by date — used for O(log n) window filtering. */
  sortedByDate: ReadonlyArray<readonly [AbsolutePath, FileMetadata]>;
  maxDays: number;
  pathspec: string | undefined;
}

/**
 * Manages the per-repository historical file cache.
 * Stores committed file data keyed by normalized repo path, supports instant
 * time-window switching by filtering the sorted-by-date index with a binary search.
 *
 * Also owns `historicalFiles` — the committed-file baseline used by pending-only
 * refreshes to restore entries when uncommitted changes are reverted.
 */
export class HistoricalFileCache {
  private cache = new Map<NormalizedRepoPath, CacheEntry>();

  // Historical (committed) file entries from the last full refresh.
  // Kept separate so pending-only refreshes can restore them when a file's
  // uncommitted changes are reverted.
  historicalFiles: Map<AbsolutePath, FileMetadata> = new Map();

  /** Clear the cache and reset the historical file baseline. */
  clear(): void {
    this.cache.clear();
    this.historicalFiles = new Map();
  }

  /**
   * Clear cache entries and historical file entries for specific repositories only.
   * Used by targeted refreshes that re-load only changed repos.
   */
  clearForRepos(normalizedRepoPaths: NormalizedRepoPath[]): void {
    for (const repoPath of normalizedRepoPaths) {
      this.cache.delete(repoPath);
    }
    // Remove historicalFiles entries that belong to the cleared repos.
    for (const absolutePath of this.historicalFiles.keys()) {
      if (normalizedRepoPaths.some(rp => absolutePath.startsWith(rp + "/") || (absolutePath as string) === (rp as string))) {
        this.historicalFiles.delete(absolutePath);
      }
    }
  }

  getEntry(normalizedRepoPath: NormalizedRepoPath): CacheEntry | undefined {
    return this.cache.get(normalizedRepoPath);
  }

  /**
   * Store (or replace) a full cache entry for a repo, building the
   * sorted-by-date index used by `filterToWindow`.
   */
  setEntry(
    normalizedRepoPath: NormalizedRepoPath,
    data: Map<AbsolutePath, FileMetadata>,
    maxDays: number,
    pathspec: string | undefined,
  ): void {
    const sortedByDate = Array.from(data.entries()).sort(
      (a, b) => a[1].date.getTime() - b[1].date.getTime(),
    );
    this.cache.set(normalizedRepoPath, { data, sortedByDate, maxDays, pathspec });
  }

  /**
   * Upgrade the cache entry only if `days` is larger than what is already stored.
   * Used for incremental threshold updates during a load so we never overwrite a
   * larger cached window with a smaller one.
   */
  upgradeEntry(
    normalizedRepoPath: NormalizedRepoPath,
    days: number,
    data: Map<AbsolutePath, FileMetadata>,
    pathspec: string | undefined,
  ): void {
    const existing = this.cache.get(normalizedRepoPath);
    if (!existing || existing.maxDays < days) {
      this.setEntry(normalizedRepoPath, data, days, pathspec);
    }
  }

  /** Returns true if every known repo has a cached result that covers `days`. */
  canServeWindow(
    days: number,
    workspaceFolders: WorkspaceFolderInfo[],
    repoPathspecs: Map<NormalizedRepoPath, string>,
  ): boolean {
    for (const folder of workspaceFolders) {
      for (const repoRelPath of folder.gitRepos) {
        const repoFullPath = repoRelPath ? path.join(folder.path, repoRelPath) : folder.path;
        const normalizedRepoPath = normalizePath(repoFullPath) as NormalizedRepoPath;
        const entry = this.cache.get(normalizedRepoPath);
        if (!entry || entry.maxDays < days) { return false; }
        if (entry.pathspec !== repoPathspecs.get(normalizedRepoPath)) { return false; }
      }
    }
    return true;
  }

  /**
   * Filter sorted cache entries to those modified within the last `days` days.
   * `sortedByDate` must be sorted ascending by date.
   * Binary searches for the cutoff then copies the tail — O(log n + k).
   */
  filterToWindow(
    sortedByDate: ReadonlyArray<readonly [AbsolutePath, FileMetadata]>,
    days: number,
  ): Map<AbsolutePath, FileMetadata> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    let lo = 0, hi = sortedByDate.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sortedByDate[mid][1].date < cutoff) { lo = mid + 1; } else { hi = mid; }
    }
    const result = new Map<AbsolutePath, FileMetadata>();
    for (let i = lo; i < sortedByDate.length; i++) {
      result.set(sortedByDate[i][0], sortedByDate[i][1]);
    }
    return result;
  }

  /**
   * Rebuild the historical baseline filtered to `days` across all repos, then
   * overlay the pending entries from `currentFreshFiles` (pending always wins).
   * Updates `historicalFiles` in place and returns the new combined fresh map.
   */
  applyWindowToFiles(
    days: number,
    workspaceFolders: WorkspaceFolderInfo[],
    repoPathspecs: Map<NormalizedRepoPath, string>,
    currentFreshFiles: Map<AbsolutePath, FileMetadata>,
  ): Map<AbsolutePath, FileMetadata> {
    const newHistorical = new Map<AbsolutePath, FileMetadata>();
    for (const folder of workspaceFolders) {
      for (const repoRelPath of folder.gitRepos) {
        const repoFullPath = repoRelPath ? path.join(folder.path, repoRelPath) : folder.path;
        const normalizedRepoPath = normalizePath(repoFullPath) as NormalizedRepoPath;
        const entry = this.cache.get(normalizedRepoPath);
        if (!entry) { continue; }
        const filtered = this.filterToWindow(entry.sortedByDate, days);
        for (const [absPath, metadata] of filtered) {
          newHistorical.set(absPath, metadata);
        }
      }
    }

    const newFresh = new Map<AbsolutePath, FileMetadata>(newHistorical);
    for (const [absPath, metadata] of currentFreshFiles) {
      if (metadata.isPending) {
        newFresh.set(absPath, metadata);
      }
    }

    this.historicalFiles = newHistorical;
    return newFresh;
  }

  /**
   * Switch to pending-only display using entries already in `currentFreshFiles`.
   * Clears `historicalFiles` and returns the pending-only subset.
   */
  applyPendingOnly(currentFreshFiles: Map<AbsolutePath, FileMetadata>): Map<AbsolutePath, FileMetadata> {
    const pendingOnly = new Map<AbsolutePath, FileMetadata>();
    for (const [absPath, metadata] of currentFreshFiles) {
      if (metadata.isPending) {
        pendingOnly.set(absPath, metadata);
      }
    }
    this.historicalFiles = new Map();
    return pendingOnly;
  }

  /**
   * Return memory stats for each known repository.
   * Uses v8.serialize for accurate byte measurement — call on demand only.
   */
  getStats(workspaceFolders: WorkspaceFolderInfo[]): CacheRepoStats[] {
    const stats: CacheRepoStats[] = [];
    for (const folder of workspaceFolders) {
      for (const repoRelPath of folder.gitRepos) {
        const repoFullPath = repoRelPath ? path.join(folder.path, repoRelPath) : folder.path;
        const normalizedRepoPath = normalizePath(repoFullPath) as NormalizedRepoPath;
        const repoLabel = repoRelPath || folder.name;
        const entry = this.cache.get(normalizedRepoPath);
        if (entry) {
          const sizeBytes = v8.serialize(entry.data).byteLength;
          stats.push({ repoLabel, repoPath: repoFullPath, entryCount: entry.data.size, sizeBytes });
        } else {
          stats.push({ repoLabel, repoPath: repoFullPath, entryCount: 0, sizeBytes: 0 });
        }
      }
    }
    return stats;
  }
}
