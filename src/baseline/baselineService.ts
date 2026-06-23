import * as vscode from "vscode";

import { getMergeBase } from "../git/gitOperations";
import { NormalizedRepoPath, asNormalizedRepoPath } from "../pathTypes";
import { GitApi, GitRepository } from "../git/gitExecutionListener";
import { SavedComparisonsService } from "../branch-compare/savedComparisonsService";

/**
 * Event payload describing what changed in the baseline state.
 * `repoPath === undefined` signals a global change (e.g. all caches invalidated).
 */
export interface BaselineChangeEvent {
  repoPath: NormalizedRepoPath | undefined;
  /** True when the saved ref itself changed (not just the merge-base cache). */
  refChanged: boolean;
}

/**
 * Per-repo baseline-ref accessor used by the blame heatmap.
 *
 * Storage / mutation is delegated to {@link SavedComparisonsService}: the
 * baseline for a repo is the `target` of whichever HEAD-source comparison
 * is currently marked as the heatmap baseline. `setBaseRef` / `clearBaseRef`
 * map onto the corresponding service mutators.
 *
 * Also owns the `(repo, source, target) → merge-base SHA` cache shared
 * between heatmap and branch-compare callers, plus the git-API subscription
 * that invalidates that cache on repo state changes.
 */
export class BaselineService implements vscode.Disposable {
  /** Cached `(repo, source..target) → merge-base SHA` promises. */
  private readonly mergeBaseCache = new Map<NormalizedRepoPath, Map<string, Promise<string>>>();
  private readonly _onDidChange = new vscode.EventEmitter<BaselineChangeEvent>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly savedComparisons: SavedComparisonsService) {
    // Bubble service changes through as baseline events for callers that
    // only subscribe to BaselineService (i.e. the heatmap controller).
    this.subscriptions.push(
      this.savedComparisons.onDidChange(event => {
        if (!event.ids || event.ids.length === 0) {
          this._onDidChange.fire({ repoPath: undefined, refChanged: true });
          return;
        }
        // Fire one event per repo affected. Most commonly only one.
        const repoKeys = new Set<NormalizedRepoPath>();
        for (const id of event.ids) {
          const cmp = this.savedComparisons.getById(id);
          if (cmp) { repoKeys.add(cmp.repoFullPath); }
        }
        for (const key of repoKeys) {
          this._onDidChange.fire({ repoPath: key, refChanged: true });
        }
      }),
    );
  }

  /**
   * Resolve the heatmap baseline ref for the given repo. Returns the
   * `target` of the comparison currently marked as the heatmap baseline,
   * or undefined if none is marked.
   */
  getBaseRef(repoFullPath: string): string | undefined {
    return this.savedComparisons.getHeatmapBaselineFor(repoFullPath)?.target;
  }

  /**
   * Mark a HEAD-source comparison with `target=ref` as the heatmap baseline
   * for this repo, creating one if no matching comparison exists.
   */
  setBaseRef(repoFullPath: string, ref: string): void {
    this.savedComparisons.setHeatmapBaselineByRefForRepo(repoFullPath, ref);
  }

  /** Clear the heatmap-baseline flag from any comparison in this repo. Doesn't delete the comparison. */
  clearBaseRef(repoFullPath: string): void {
    // Cache is keyed by `source..target` ref strings, so clearing the
    // heatmap-baseline flag doesn't invalidate any cached merge-base.
    // The service-event bubble in the constructor already fires onDidChange
    // for downstream refresh.
    this.savedComparisons.clearHeatmapBaselineForRepoByRef(repoFullPath);
  }

  hasAnyBaseRef(): boolean {
    // True when at least one repo has a comparison marked as heatmap baseline.
    return this.savedComparisons.getAll().some(c => c.isHeatmapBaseline);
  }

  /**
   * Memoized `getMergeBase(source, target)` for a repo.
   *
   * `source` defaults to `"HEAD"` so the original 2-arg call sites (heatmap)
   * keep working. The branch-compare view passes both refs to support
   * arbitrary `source..target` comparisons (e.g. `v1.4..v1.2`).
   *
   * An entry rejected by git is evicted so a retry doesn't get permanently
   * stuck on a transient error.
   */
  getMergeBase(repoFullPath: string, target: string, source: string = "HEAD"): Promise<string> {
    const key = asNormalizedRepoPath(repoFullPath);
    let inner = this.mergeBaseCache.get(key);
    if (!inner) {
      inner = new Map();
      this.mergeBaseCache.set(key, inner);
    }
    const cacheKey = `${source}..${target}`;
    const cached = inner.get(cacheKey);
    if (cached) { return cached; }
    const promise = getMergeBase(repoFullPath, source, target);
    inner.set(cacheKey, promise);
    promise.catch(() => { inner!.delete(cacheKey); });
    return promise;
  }

  /**
   * Drop cached merge-bases for one repo. Call on any git state change for
   * that repo (HEAD move, fetch, branch switch). Fires onDidChange so views
   * relying on derived data refresh themselves.
   */
  invalidateMergeBaseCache(repoFullPath: string): void {
    const key = asNormalizedRepoPath(repoFullPath);
    if (!this.mergeBaseCache.delete(key)) { return; }
    this._onDidChange.fire({ repoPath: key, refChanged: false });
  }

  /** Drop all cached merge-bases (e.g. on workspace folder change). */
  invalidateAllMergeBaseCaches(): void {
    if (this.mergeBaseCache.size === 0) { return; }
    this.mergeBaseCache.clear();
    this._onDidChange.fire({ repoPath: undefined, refChanged: false });
  }

  /**
   * Subscribe to the VS Code git API so any repo state change
   * (HEAD move, branch switch, fetch) drops the cached merge-base for that
   * repo and notifies listeners. Call once at extension activation.
   */
  connectGitApi(api: GitApi): void {
    const handle = (repo: GitRepository) => {
      this.invalidateMergeBaseCache(repo.rootUri.fsPath);
    };
    const subscribe = (repo: GitRepository) => {
      this.subscriptions.push(repo.state.onDidChange(() => handle(repo)));
    };
    for (const repo of api.repositories) {
      subscribe(repo);
    }
    this.subscriptions.push(api.onDidOpenRepository(repo => subscribe(repo)));
  }

  private readonly subscriptions: vscode.Disposable[] = [];

  dispose(): void {
    for (const s of this.subscriptions) { s.dispose(); }
    this._onDidChange.dispose();
  }
}
