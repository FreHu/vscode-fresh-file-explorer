import * as path from "path";

import type { AbsolutePath } from "../pathTypes";
import type { WorkspaceFolderInfo } from "../types";

// Inlined rather than imported from "../utils" — that module has a top-level
// `import vscode`, which would drag this otherwise vscode-free, directly
// unit-testable module into needing the extension host to even load.
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Checks whether `normalizedFilePath` belongs to any of the given normalized repo paths. */
export function fileInTargetRepo(normalizedFilePath: string, targetRepoPaths: string[]): boolean {
  return targetRepoPaths.some(rp => normalizedFilePath.startsWith(rp + "/") || normalizedFilePath === rp);
}

/**
 * Returns a copy of `map` with all entries whose path belongs to any of
 * `targetRepoPaths` removed. Used to strip a repo's stale data before reload.
 */
export function fileMapExcludingRepos<V>(
  map: Map<AbsolutePath, V>,
  targetRepoPaths: string[],
): Map<AbsolutePath, V> {
  const result = new Map<AbsolutePath, V>();
  for (const [absPath, value] of map) {
    if (!fileInTargetRepo(absPath, targetRepoPaths)) {
      result.set(absPath, value);
    }
  }
  return result;
}

/**
 * Returns a filtered copy of `workspaceFolders` that contains only the repos
 * present in `targetRepoPaths`. Folders with no matching repos are excluded.
 */
export function buildTargetWorkspaceFolders(
  workspaceFolders: WorkspaceFolderInfo[],
  targetRepoPaths: string[],
): WorkspaceFolderInfo[] {
  const result: WorkspaceFolderInfo[] = [];
  for (const folder of workspaceFolders) {
    const filteredRepos = folder.gitRepos.filter(repoRelPath => {
      const repoFullPath = repoRelPath ? path.join(folder.path, repoRelPath) : folder.path;
      return targetRepoPaths.includes(normalizePath(repoFullPath));
    });
    if (filteredRepos.length > 0) {
      result.push({ ...folder, gitRepos: filteredRepos });
    }
  }
  return result;
}

/**
 * The maximum historical window to load from git in one pass, plus the day
 * thresholds at which incremental tree updates should fire. Pending-only
 * windows need neither (returns no thresholds); disabling incremental
 * loading collapses the threshold list to just the selected window.
 */
export function computeHistoricalLoadPlan(
  historicalWindows: { days: number }[],
  histDays: number,
  pendingOnly: boolean,
  incrementalLoading: boolean,
): { maxDays: number; thresholds: number[] } {
  const maxDays = historicalWindows.length > 0
    ? historicalWindows[historicalWindows.length - 1].days
    : histDays;
  const thresholds = pendingOnly
    ? []
    : incrementalLoading
      ? historicalWindows.map(tw => tw.days).filter(d => d <= histDays)
      : [histDays];
  return { maxDays, thresholds };
}

/**
 * The display file map (files.exclude applied by owner) narrowed to one repo,
 * or the whole map when no scope is given. Used to build a repo's grouped
 * children and to resolve a group header's children/actions to that repo.
 */
export function scopeFilesByRepo<V>(source: Map<AbsolutePath, V>, repoScope?: string): Map<AbsolutePath, V> {
  if (!repoScope) { return source; }
  const prefix = repoScope.endsWith("/") ? repoScope : repoScope + "/";
  const scoped = new Map<AbsolutePath, V>();
  for (const [p, m] of source) {
    if (p === repoScope || (p as string).startsWith(prefix)) { scoped.set(p, m); }
  }
  return scoped;
}
