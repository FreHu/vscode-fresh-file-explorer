import * as vscode from "vscode";

import { BaselineService } from "../baseline/baselineService";
import { SavedComparisonsService, HEAD_SOURCE } from "./savedComparisonsService";
import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { log } from "../extension/logger";
import { ContextManager } from "../extension/contextManager";
import { WorkspaceStateManager } from "../extension/workspaceStateManager";
import { ConfigService } from "../config/configService";
import { SortOrder } from "../types";
import {
  buildChangedFiles,
  buildFolderTree,
  collectFilesIn,
  ChangedFile,
  fetchCommittedDiff,
  fetchCommitInfoInRange,
  fetchMergeConeStats,
  fetchWorkingTreeStatus,
  fetchWorkingTreeNumstat,
  FolderNode,
} from "./branchCompareData";
import {
  BranchCompareFileItem,
  BranchCompareFolderItem,
  BranchCompareMessageItem,
  BranchCompareTreeItem,
  RepoSectionItem,
} from "./branchCompareTreeItems";
import {
  BranchCompareGroupItem,
  buildGroupedItems,
  sortFilesForGrouping,
} from "./branchCompareGroupingBuilder";
import { AbsolutePath, NormalizedRepoPath } from "../pathTypes";
import { normalizePath } from "../utils";
import { listWorkspaceRepos } from "../utils/pathUtils";
import { GroupingMode } from "../fresh-files/groupingMode";
import { DiffMode } from "./branchCompareConstants";
import { FilesExcludeFilter } from "../fresh-files/filesExcludeFilter";

/**
 * In-memory state for one rendered comparison. Mirrors the persisted shape
 * from `SavedComparisonsService` plus the resolved diff data.
 */
interface ResolvedComparison {
  id: string;
  repoFullPath: AbsolutePath;
  repoName: string;
  source: string;
  target: string;
  label?: string;
  /** Resolved file set. `undefined` while loading; empty array means "no changes". */
  files: ChangedFile[] | undefined;
  /**
   * Same set before `files.exclude` is applied. Kept so toggling the setting
   * (or editing `files.exclude` itself) can re-derive `files`/`tree` without
   * a git re-fetch.
   */
  rawFiles: ChangedFile[] | undefined;
  tree: FolderNode | undefined;
  error: string | undefined;
  /**
   * True when the last refresh failed because `source` or `target` doesn't
   * resolve to a commit. The settings panel already flags these inputs with a
   * red X — the tree suppresses the section entirely so users aren't seeing
   * a broken comparison "vs ddd · no changes" alongside a git error message.
   */
  invalidRef: boolean;
  /**
   * Total vs first-parent commit counts for `mergeBase..source`. When `total`
   * exceeds `firstParent`, the cone fans out via merges — the section tooltip
   * surfaces this so HEAD~N users don't get blindsided by merged-in changes.
   */
  mergeCone: { total: number; firstParent: number } | undefined;
  /** Per-comparison grouping mode, resolved from the saved record (default applied). */
  groupingMode: GroupingMode;
  /** Per-comparison diff mode — `merge` (vs merge-base) or `full` (vs target ref). */
  diffMode: DiffMode;
  /**
   * Whether the last successful load fetched commit info. Drives the lazy
   * re-fetch when grouping switches into a mode that needs commit metadata
   * (Author / Commit Hash / Moon Phase / Retrograde) but the cached files
   * were loaded without it.
   */
  hasCommitInfo: boolean;
  /** True for auto-follow comparisons (in-memory, owned by AutoFollowController). */
  auto: boolean;
  /** Hide files marked reviewed for this comparison (per-comparison, from the saved record). */
  hideReviewed: boolean;
}

/**
 * Match the patterns git emits when a ref can't be resolved. Used to bucket
 * those errors as "configured wrong" (suppress the section) versus "something
 * else went wrong" (keep showing so the user sees the cause).
 */
function isInvalidRefError(err: unknown): boolean {
  const s = String(err);
  return /not a valid object name|unknown revision|ambiguous argument|bad revision/i.test(s);
}

/**
 * Tree provider for the Branch Compare view.
 *
 * One section per **active saved comparison** (managed by
 * {@link SavedComparisonsService}). The legacy "one baseline per repo" model
 * has been generalized — a repo can have multiple active comparisons, each
 * with its own source/target ref pair.
 *
 * Auto-refresh triggers:
 *  - SavedComparisonsService change (add / update / delete / toggle active)
 *  - BaselineService merge-base invalidation (branch switch, fetch, etc.)
 *  - FreshFileProvider repo discovery completing (initial load)
 *  - File save (working-tree refresh path, only HEAD-source comparisons)
 */
export class BranchCompareProvider implements vscode.TreeDataProvider<BranchCompareTreeItem>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<BranchCompareTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Resolved comparison state, keyed by the persisted comparison id. */
  private comparisons = new Map<string, ResolvedComparison>();

  /** Per-comparison-id load token — used to drop stale results when reloads race. */
  private loadingTokens = new Map<string, number>();

  private readonly subscriptions: vscode.Disposable[] = [];

  /** Snapshot of `repo → branch name` for change-detection on tooltip refresh. */
  private lastSeenBranches = new Map<NormalizedRepoPath, string>();

  /**
   * Left-click mode for file items: `true` opens the diff (the default — diffs
   * are the point of this view), `false` opens the working-tree file. Separate
   * from Fresh Files' own open-changes mode.
   */
  private openChangesMode: boolean = WorkspaceStateManager.getBranchCompareOpenChangesMode();

  /** Applies each owning workspace folder's `files.exclude` to comparison file sets. */
  private filesExcludeFilter = new FilesExcludeFilter(
    () => ConfigService.getRespectFilesExclude(),
    (folderPath) => ConfigService.getFilesExcludeExpression(vscode.Uri.file(folderPath)),
  );

  /**
   * "Reviewed" checkbox state — repo-relative path → mtime (ms) at review
   * time, keyed by comparison id. Two comparisons on the same repo/path track
   * separately: reviewing a file in `vs main` says nothing about `vs
   * release-q4`. The mtime drives HEAD-source auto-reset (see
   * {@link reconcileReviewed}) and is otherwise unused.
   */
  private reviewedFiles: Map<string, Map<string, number>> = new Map(
    Object.entries(WorkspaceStateManager.getReviewedFiles()).map(([id, paths]) => [id, new Map(Object.entries(paths))]),
  );

  constructor(
    private readonly baselineService: BaselineService,
    private readonly freshFileProvider: FreshFileProvider,
    private readonly savedComparisons: SavedComparisonsService,
  ) {
    ContextManager.setBranchCompareOpenChangesMode(this.openChangesMode);

    // React to comparison list changes (add / update / delete / toggle active).
    this.subscriptions.push(
      this.savedComparisons.onDidChange(event => {
        if (!event.ids || event.ids.length === 0) {
          void this.refreshAll();
        } else {
          // Reconcile our in-memory map with the new persisted state. The
          // sync rebuilds the Map in service order so reorders propagate, and
          // picks up per-comparison grouping-mode changes.
          this.syncComparisonsToService();
          if (event.displayOnly) {
            // Grouping-mode-only change. Re-render from cached files; only
            // re-fetch the rare comparison whose new mode needs commit info the
            // cached load didn't include.
            for (const id of event.ids) {
              const cmp = this.comparisons.get(id);
              if (
                cmp && cmp.files && cmp.files.length > 0 &&
                this.groupingNeedsCommitInfo(cmp.groupingMode) && !cmp.hasCommitInfo
              ) {
                void this.refreshComparison(id, true);
              }
            }
          } else if (!event.reorderOnly) {
            // Skip the diff re-fetch for pure reorders — nothing about the
            // ref pair or filter state changed.
            for (const id of event.ids) {
              if (this.comparisons.has(id)) {
                void this.refreshComparison(id, true);
              }
            }
          }
          this.fireChange();
        }
      }),
    );

    // Merge-base invalidation (e.g. branch switch via git extension).
    // BaselineService fires onDidChange for repo state changes.
    this.subscriptions.push(
      this.baselineService.onDidChange(event => {
        if (event.repoPath === undefined) {
          void this.refreshAll();
          return;
        }
        const ids: string[] = [];
        for (const cmp of this.comparisons.values()) {
          const repoKey = normalizePath(cmp.repoFullPath) as NormalizedRepoPath;
          if (repoKey === event.repoPath) { ids.push(cmp.id); }
        }
        for (const id of ids) {
          void this.refreshComparison(id, false);
        }
      }),
    );

    // Re-render section tooltips when fresh-files branch info changes.
    this.subscriptions.push(
      this.freshFileProvider.onDidChangeTreeData(() => {
        if (this.detectBranchChange()) {
          this._onDidChangeTreeData.fire();
        }
      }),
    );

    // Initial load gated on repo discovery completion.
    if (!this.freshFileProvider.areReposReady) {
      this.subscriptions.push(
        this.freshFileProvider.onReposReady(() => {
          log("branchCompare: repos ready — running initial refresh");
          void this.refreshAll();
        }),
      );
    }

    this.updateContextKey();
  }

  /**
   * Compare the current branch map against `lastSeenBranches`. Returns true
   * and updates the snapshot if any change is detected.
   */
  private detectBranchChange(): boolean {
    let changed = false;
    const next = new Map<NormalizedRepoPath, string>();
    for (const cmp of this.comparisons.values()) {
      const repoKey = normalizePath(cmp.repoFullPath) as NormalizedRepoPath;
      const branch = this.freshFileProvider.getRepoBranch(repoKey);
      if (branch !== undefined) { next.set(repoKey, branch); }
      if (this.lastSeenBranches.get(repoKey) !== branch) { changed = true; }
    }
    if (!changed) {
      for (const key of this.lastSeenBranches.keys()) {
        if (!next.has(key)) { changed = true; break; }
      }
    }
    this.lastSeenBranches = next;
    return changed;
  }

  // ── TreeDataProvider ────────────────────────────────────────────────────

  getTreeItem(element: BranchCompareTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: BranchCompareTreeItem): Promise<BranchCompareTreeItem[]> {
    if (!element) {
      return this.buildRootSections();
    }
    if (element instanceof RepoSectionItem) {
      return this.getChildrenForSection(element);
    }
    if (element instanceof BranchCompareFolderItem) {
      const cmp = this.comparisons.get(element.comparisonId);
      if (!cmp) { return []; }
      return this.renderFolderChildren(cmp, element.node);
    }
    if (element instanceof BranchCompareGroupItem) {
      return this.renderGroupChildren(element);
    }
    return [];
  }

  /** Look up a resolved comparison by id. Returns undefined if it's no longer active. */
  getComparison(id: string): ResolvedComparison | undefined {
    return this.comparisons.get(id);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Force re-fetch for every active comparison. Bails early when fresh-file-
   * provider hasn't finished repo discovery — the constructor's onReposReady
   * subscription will retry once discovery completes.
   */
  async refreshAll(): Promise<void> {
    if (!this.freshFileProvider.areReposReady) {
      log("branchCompare: refreshAll deferred — waiting for repo discovery");
      return;
    }
    this.syncComparisonsToService();
    const ids = [...this.comparisons.keys()];
    log(`branchCompare: refreshAll loading ${ids.length} comparison(s)`);
    await Promise.all(ids.map(id => this.refreshComparison(id, true)));
    this.fireChange();
  }

  /** Re-fetch a single comparison's diff. `markStale` shows a loading state first. */
  async refreshComparison(id: string, markStale: boolean): Promise<void> {
    this.syncComparisonsToService();
    const cmp = this.comparisons.get(id);
    if (!cmp) {
      this.fireChange();
      return;
    }

    if (markStale) {
      cmp.files = undefined;
      cmp.rawFiles = undefined;
      cmp.tree = undefined;
      cmp.error = undefined;
      cmp.invalidRef = false;
      cmp.mergeCone = undefined;
      this.fireChange();
    }

    const myToken = (this.loadingTokens.get(id) ?? 0) + 1;
    this.loadingTokens.set(id, myToken);

    try {
      const sourceRef = cmp.source;
      // The base everything diffs against. `full` mode diffs the target ref
      // directly (exact target..source delta); `merge` mode diffs against the
      // merge-base (PR-style — what source adds since diverging). Full mode
      // needs no merge-base, saving a git call.
      const base = cmp.diffMode === "full"
        ? cmp.target
        : await this.baselineService.getMergeBase(cmp.repoFullPath, cmp.target, sourceRef);
      if (this.loadingTokens.get(id) !== myToken) return;

      // Working-tree overlay only applies when source === HEAD. Other source
      // refs aren't necessarily checked out — their working tree isn't ours.
      const includeWorkingTree = sourceRef === HEAD_SOURCE;
      const wantsCommitInfo = this.groupingNeedsCommitInfo(cmp.groupingMode);

      const [committed, workingTree, workingTreeNumstat, commitInfo, mergeCone] = await Promise.all([
        fetchCommittedDiff(cmp.repoFullPath, base, sourceRef),
        includeWorkingTree
          ? fetchWorkingTreeStatus(cmp.repoFullPath)
          : Promise.resolve([]),
        // Cheap working-tree line counts for pending entries (HEAD diff only).
        includeWorkingTree
          ? fetchWorkingTreeNumstat(cmp.repoFullPath).catch(err => {
              log(`branchCompare: working-tree numstat failed (${cmp.repoFullPath}) — ${err}`, "warn");
              return undefined;
            })
          : Promise.resolve(undefined),
        wantsCommitInfo
          ? fetchCommitInfoInRange(cmp.repoFullPath, base, sourceRef).catch(err => {
              log(`branchCompare: commit-info fetch failed (${cmp.repoFullPath}) — ${err}`, "warn");
              return undefined;
            })
          : Promise.resolve(undefined),
        fetchMergeConeStats(cmp.repoFullPath, base, sourceRef),
      ]);
      if (this.loadingTokens.get(id) !== myToken) return;

      cmp.rawFiles = buildChangedFiles(cmp.repoFullPath, committed, workingTree, commitInfo, workingTreeNumstat);
      cmp.files = this.filterExcludedFiles(cmp.repoFullPath, cmp.rawFiles);
      cmp.tree = buildFolderTree(cmp.files);
      cmp.error = undefined;
      cmp.mergeCone = mergeCone;
      cmp.hasCommitInfo = wantsCommitInfo;
      // Drop review marks for files no longer in the diff, and (HEAD-source
      // only) for files edited again since being marked reviewed.
      await this.reconcileReviewed(cmp);
    } catch (err) {
      if (this.loadingTokens.get(id) !== myToken) return;
      cmp.error = String(err);
      cmp.invalidRef = isInvalidRefError(err);
      cmp.files = [];
      cmp.rawFiles = [];
      cmp.tree = undefined;
      cmp.mergeCone = undefined;
      cmp.hasCommitInfo = false;
      log(`branchCompare: failed to load comparison ${id} (${cmp.source}..${cmp.target} in ${cmp.repoFullPath}) — ${err}`, "warn");
    }

    this.fireChange();
  }

  /**
   * Re-fetch every active comparison anchored to the given repo. Used after
   * destructive operations (e.g. Restore from Baseline) where any comparison
   * touching that repo's working tree needs to re-render.
   */
  async refreshComparisonsForRepo(repoFullPath: string): Promise<void> {
    this.syncComparisonsToService();
    const repoKey = normalizePath(repoFullPath) as NormalizedRepoPath;
    const ids: string[] = [];
    for (const cmp of this.comparisons.values()) {
      if ((normalizePath(cmp.repoFullPath) as NormalizedRepoPath) === repoKey) {
        ids.push(cmp.id);
      }
    }
    await Promise.all(ids.map(id => this.refreshComparison(id, false)));
    this.fireChange();
  }

  /**
   * Re-run the working-tree overlay only for the given repo. Triggered on
   * file save. Affects only HEAD-source comparisons in that repo — others
   * don't track the working tree.
   */
  async refreshWorkingTree(repoPath?: NormalizedRepoPath): Promise<void> {
    this.syncComparisonsToService();
    const targets: ResolvedComparison[] = [];
    for (const cmp of this.comparisons.values()) {
      if (cmp.source !== HEAD_SOURCE) { continue; }
      const repoKey = normalizePath(cmp.repoFullPath) as NormalizedRepoPath;
      if (repoPath && repoKey !== repoPath) { continue; }
      targets.push(cmp);
    }
    await Promise.all(targets.map(cmp => this.refreshComparison(cmp.id, false)));
    this.fireChange();
  }

  /** True when at least one active comparison exists. Drives the view's `when`. */
  hasAnyActive(): boolean {
    return this.savedComparisons.hasAnyActive();
  }

  // ── files.exclude ────────────────────────────────────────────────────────

  /**
   * Drop files hidden by their owning workspace folder's `files.exclude`.
   * Each comparison is rooted at one repo, so — unlike the Fresh Files tree,
   * which renders the same file under multiple overlapping-root nodes — a
   * file here has exactly one owning folder, making this the owner-based
   * check rather than a per-node one.
   */
  private filterExcludedFiles(repoFullPath: AbsolutePath, files: ChangedFile[]): ChangedFile[] {
    if (!this.filesExcludeFilter.enabled) { return files; }
    const folders = this.freshFileProvider.workspaceFolders;
    return files.filter(f => !this.filesExcludeFilter.isExcludedByOwner(
      normalizePath(`${repoFullPath}/${f.pathInRepo}`),
      folders,
    ));
  }

  /**
   * React to a `files.exclude` or respect-toggle change: drop compiled
   * matchers and re-derive each comparison's filtered files/tree from the
   * cached raw diff — no git I/O.
   */
  applyFilesExcludeChange(): void {
    this.filesExcludeFilter.invalidate();
    for (const cmp of this.comparisons.values()) {
      if (cmp.rawFiles === undefined) { continue; }
      cmp.files = this.filterExcludedFiles(cmp.repoFullPath, cmp.rawFiles);
      cmp.tree = buildFolderTree(cmp.files);
    }
    this.fireChange();
  }

  // ── Reviewed state ──────────────────────────────────────────────────────

  isReviewed(comparisonId: string, pathInRepo: string): boolean {
    return this.reviewedFiles.get(comparisonId)?.has(pathInRepo) ?? false;
  }

  /** True when every file in `files` is reviewed. Empty input is never "reviewed". */
  private allReviewed(comparisonId: string, files: ChangedFile[]): boolean {
    return files.length > 0 && files.every(f => this.isReviewed(comparisonId, f.pathInRepo));
  }

  /** How many of `files` are marked reviewed. */
  private reviewedCountIn(comparisonId: string, files: ChangedFile[] | undefined): number {
    if (!files) { return 0; }
    return files.filter(f => this.isReviewed(comparisonId, f.pathInRepo)).length;
  }

  /** Set a single file's reviewed state. Re-renders (display-only, no git). */
  setFileReviewed(comparisonId: string, file: ChangedFile, reviewed: boolean): void {
    this.setFilesReviewedInternal(comparisonId, [file], reviewed);
    this.fireChange();
  }

  /**
   * Set every file under a folder to the same reviewed state. Used when the
   * folder checkbox is toggled — the folder checkbox is just an aggregation (never
   * independently stored), so clicking it always means "mark everything
   * currently under here" rather than restoring some prior folder-only state.
   */
  setFilesReviewed(comparisonId: string, files: ChangedFile[], reviewed: boolean): void {
    this.setFilesReviewedInternal(comparisonId, files, reviewed);
    this.fireChange();
  }

  private setFilesReviewedInternal(comparisonId: string, files: ChangedFile[], reviewed: boolean): void {
    let map = this.reviewedFiles.get(comparisonId);
    if (reviewed) {
      if (!map) {
        map = new Map();
        this.reviewedFiles.set(comparisonId, map);
      }
      for (const f of files) { map.set(f.pathInRepo, 0); }
      this.persistReviewed();
      // Mtime capture is async (workspace.fs.stat) and only matters for
      // HEAD-source comparisons — fire-and-forget so the checkbox click
      // itself never waits on disk I/O.
      void this.captureReviewedMtimes(comparisonId, files);
    } else if (map) {
      for (const f of files) { map.delete(f.pathInRepo); }
      if (map.size === 0) { this.reviewedFiles.delete(comparisonId); }
      this.persistReviewed();
    }
  }

  /** Record each file's current mtime as the "reviewed at" baseline, HEAD-source comparisons only. */
  private async captureReviewedMtimes(comparisonId: string, files: ChangedFile[]): Promise<void> {
    const cmp = this.comparisons.get(comparisonId);
    if (!cmp || cmp.source !== HEAD_SOURCE) { return; }
    const map = this.reviewedFiles.get(comparisonId);
    if (!map) { return; }
    await Promise.all(files.map(async f => {
      if (!map.has(f.pathInRepo)) { return; } // unreviewed again before this resolved
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(f.absolutePath));
        map.set(f.pathInRepo, stat.mtime);
      } catch {
        // File unreadable (e.g. deleted right after being marked) — leave the
        // placeholder; reconcileReviewed's own stat call will drop it next refresh.
      }
    }));
    this.persistReviewed();
  }

  /**
   * Drop review marks that no longer make sense after a refresh: paths no
   * longer in the diff at all, and — for HEAD-source comparisons only, since
   * only those overlay the working tree — files edited again since being
   * marked reviewed. Fixed ref-to-ref comparisons have nothing local to
   * invalidate against, so their marks are left untouched here.
   */
  private async reconcileReviewed(cmp: ResolvedComparison): Promise<void> {
    const map = this.reviewedFiles.get(cmp.id);
    if (!map || map.size === 0) { return; }

    const filesByPath = new Map((cmp.files ?? []).map(f => [f.pathInRepo, f]));
    let changed = false;
    for (const path of [...map.keys()]) {
      if (!filesByPath.has(path)) {
        map.delete(path);
        changed = true;
      }
    }

    if (cmp.source === HEAD_SOURCE && map.size > 0) {
      await Promise.all([...map.entries()].map(async ([path, recordedMtime]) => {
        const file = filesByPath.get(path);
        if (!file) { return; }
        try {
          const stat = await vscode.workspace.fs.stat(vscode.Uri.file(file.absolutePath));
          if (stat.mtime !== recordedMtime) {
            map.delete(path);
            changed = true;
          }
        } catch {
          // File no longer readable (e.g. deleted after being reviewed) — drop the mark.
          map.delete(path);
          changed = true;
        }
      }));
    }

    if (map.size === 0) { this.reviewedFiles.delete(cmp.id); }
    if (changed) { this.persistReviewed(); }
  }

  /** Drop all reviewed state for a comparison — the diff it referred to no longer exists. */
  private clearReviewed(comparisonId: string): void {
    if (this.reviewedFiles.delete(comparisonId)) {
      this.persistReviewed();
    }
  }

  private persistReviewed(): void {
    const record: Record<string, Record<string, number>> = {};
    for (const [id, paths] of this.reviewedFiles) {
      record[id] = Object.fromEntries(paths);
    }
    WorkspaceStateManager.setReviewedFiles(record);
  }

  // ── Grouping ────────────────────────────────────────────────────────────

  private groupingNeedsCommitInfo(mode: GroupingMode): boolean {
    return mode === "Author" || mode === "Commit Hash" || mode === "Moon Phase" || mode === "Retrograde";
  }

  // ── Open mode ─────────────────────────────────────────────────────────────

  /**
   * Set the left-click mode: `true` opens diffs, `false` opens files. Re-renders
   * from cached data (no git) — only the file items' `command` changes.
   */
  setOpenMode(value: boolean): void {
    if (value === this.openChangesMode) { return; }
    this.openChangesMode = value;
    WorkspaceStateManager.setBranchCompareOpenChangesMode(value);
    ContextManager.setBranchCompareOpenChangesMode(value);
    this.fireChange();
  }

  dispose(): void {
    for (const s of this.subscriptions) { s.dispose(); }
    this._onDidChangeTreeData.dispose();
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  /**
   * Reconcile the in-memory `comparisons` map with the active set from
   * `SavedComparisonsService`. Adds new active comparisons (with empty
   * file data so they show "Loading…"), drops removed/inactive ones,
   * patches mutated source/target/label fields.
   */
  private syncComparisonsToService(): void {
    const active = this.savedComparisons.getActive();
    const reposByPath = this.buildRepoLookup();
    const previous = this.comparisons;
    // Rebuild the Map from scratch so iteration order matches the service's
    // array order — patching existing entries in place would freeze the order
    // at first insertion and make reorders invisible to the tree.
    const next = new Map<string, ResolvedComparison>();
    const seenIds = new Set<string>();

    for (const sc of active) {
      const repoInfo = reposByPath.get(sc.repoFullPath);
      if (!repoInfo) {
        // Saved for a repo that's not currently in the workspace — skip silently.
        continue;
      }
      seenIds.add(sc.id);
      const existing = previous.get(sc.id);
      if (existing) {
        // Detect refs/label changes — invalidate file data so the view reloads.
        const refsChanged = existing.source !== sc.source || existing.target !== sc.target;
        if (refsChanged) {
          existing.source = sc.source;
          existing.target = sc.target;
          existing.files = undefined;
          existing.rawFiles = undefined;
          existing.tree = undefined;
          existing.error = undefined;
          existing.invalidRef = false;
          existing.mergeCone = undefined;
          // A different ref pair is a different diff — stale review checkmarks
          // would be actively misleading, not just outdated.
          this.clearReviewed(sc.id);
        }
        existing.label = sc.label;
        existing.repoName = repoInfo.repoName;
        existing.groupingMode = sc.groupingMode;
        existing.auto = sc.auto ?? false;
        existing.hideReviewed = sc.hideReviewed ?? false;
        // diffMode change invalidates the diff — drop cached files so it reloads.
        if (existing.diffMode !== sc.diffMode) {
          existing.diffMode = sc.diffMode;
          existing.files = undefined;
          existing.rawFiles = undefined;
          existing.tree = undefined;
          existing.error = undefined;
          existing.invalidRef = false;
          existing.mergeCone = undefined;
          // merge vs full is a different file set — same reasoning as a ref change.
          this.clearReviewed(sc.id);
        }
        next.set(sc.id, existing);
      } else {
        next.set(sc.id, {
          id: sc.id,
          repoFullPath: repoInfo.repoFullPath,
          repoName: repoInfo.repoName,
          source: sc.source,
          target: sc.target,
          label: sc.label,
          files: undefined,
          rawFiles: undefined,
          tree: undefined,
          error: undefined,
          invalidRef: false,
          mergeCone: undefined,
          groupingMode: sc.groupingMode,
          diffMode: sc.diffMode,
          hasCommitInfo: false,
          auto: sc.auto ?? false,
          hideReviewed: sc.hideReviewed ?? false,
        });
      }
    }

    // Drop tokens for comparisons that no longer exist so a stale in-flight
    // load can't write into the next active version of the same id later.
    for (const id of previous.keys()) {
      if (!seenIds.has(id)) {
        this.loadingTokens.delete(id);
      }
    }

    // Drop reviewed-state for comparisons that no longer exist at all (deleted).
    // Checked against every saved comparison, not just the active ones — a
    // comparison the user merely toggled inactive must keep its review progress.
    if (this.reviewedFiles.size > 0) {
      const allIds = new Set(this.savedComparisons.getAll().map(c => c.id));
      let prunedReviewed = false;
      for (const id of this.reviewedFiles.keys()) {
        if (!allIds.has(id)) {
          this.reviewedFiles.delete(id);
          prunedReviewed = true;
        }
      }
      if (prunedReviewed) {
        this.persistReviewed();
      }
    }

    this.comparisons = next;
    this.updateContextKey();
  }

  /**
   * Build a `(normalizedRepoPath → {fullPath, displayName})` lookup map from
   * the repos already discovered by `FreshFileProvider`. Pure reformatter —
   * does **no** git work. Repo discovery is owned exclusively by FFP.
   */
  private buildRepoLookup(): Map<NormalizedRepoPath, { repoFullPath: AbsolutePath; repoName: string }> {
    const out = new Map<NormalizedRepoPath, { repoFullPath: AbsolutePath; repoName: string }>();
    for (const repo of listWorkspaceRepos(this.freshFileProvider.workspaceFolders)) {
      out.set(repo.normalizedPath, { repoFullPath: repo.repoFullPath, repoName: repo.name });
    }
    return out;
  }

  private buildRootSections(): RepoSectionItem[] {
    this.syncComparisonsToService();
    const sections: RepoSectionItem[] = [];
    // Dedupe by (repo, source, target, groupingMode, diffMode). Two comparisons
    // matching on all of these render byte-identical trees, so collapse them.
    // A difference in grouping (flat vs by-commit) or diffMode (merge vs full —
    // different file sets) is intentional, so those render side by side. The
    // settings panel warns only on the fully-identical case.
    // First insertion wins — matches the persisted-list order users can
    // reorder via the panel.
    const seenTriples = new Set<string>();
    for (const cmp of this.comparisons.values()) {
      // Hide comparisons whose source/target failed to resolve. The settings
      // panel already shows a red X next to the offending input — surfacing
      // it again here as a broken "vs ddd · no changes" section just adds noise.
      if (cmp.invalidRef) { continue; }
      const tripleKey = `${cmp.repoFullPath}\0${cmp.source}\0${cmp.target}\0${cmp.groupingMode}\0${cmp.diffMode}`;
      if (seenTriples.has(tripleKey)) { continue; }
      seenTriples.add(tripleKey);
      const fileCount = cmp.files?.length ?? 0;
      const repoKey = normalizePath(cmp.repoFullPath) as NormalizedRepoPath;
      // Auto sections store their branch in `label` (resolved from git), so use that — `getRepoBranch` may be empty for a worktree the git extension
      // didn't open, and the dismiss action needs the branch name.
      const currentBranch = cmp.auto ? cmp.label : this.freshFileProvider.getRepoBranch(repoKey);
      const sectionLabel = cmp.label
        ? cmp.label
        : `${cmp.repoName} · ${displayRef(cmp.source)}..${displayRef(cmp.target)}`;
      sections.push(
        new RepoSectionItem(
          cmp.repoFullPath,
          sectionLabel,
          cmp.target,
          fileCount,
          true,
          currentBranch,
          cmp.id,
          cmp.mergeCone,
          cmp.diffMode,
          cmp.auto,
          cmp.hideReviewed,
          this.reviewedCountIn(cmp.id, cmp.files),
        ),
      );
    }
    // No sort — section order follows the persisted comparison list so the
    // settings panel's up/down reorder is reflected in the tree.
    return sections;
  }

  private getChildrenForSection(section: RepoSectionItem): BranchCompareTreeItem[] {
    const cmp = section.comparisonId
      ? this.comparisons.get(section.comparisonId)
      : undefined;
    if (!cmp) {
      return [new BranchCompareMessageItem("Comparison not found", "warning")];
    }
    if (cmp.error) {
      return [new BranchCompareMessageItem(cmp.error, "error")];
    }
    if (cmp.files === undefined) {
      return [new BranchCompareMessageItem("Loading…", "loading~spin")];
    }
    if (cmp.files.length === 0) {
      // Distinguish "diff is empty because source is at or behind target" from
      // a real zero-change comparison. When the cone count from `mergeBase..source`
      // is 0, source has no commits past the merge-base — `git diff` of that
      // range is empty by construction. Users hit this when they flip refs
      // expecting a reversed view; explain what's happening and what to do.
      if (cmp.mergeCone && cmp.mergeCone.total === 0) {
        return [new BranchCompareMessageItem(
          `${displayRef(cmp.source)} has nothing new vs ${displayRef(cmp.target)}. Swap source and target to see what ${displayRef(cmp.target)} adds.`,
          "info",
        )];
      }
      return [new BranchCompareMessageItem(
        `No changes (${displayRef(cmp.source)}..${displayRef(cmp.target)})`,
        "check",
      )];
    }

    if (cmp.hideReviewed && this.visibleFiles(cmp, cmp.files).length === 0) {
      return [new BranchCompareMessageItem(`All ${cmp.files.length} changed file(s) reviewed`, "check")];
    }

    switch (cmp.groupingMode) {
      case "Flat List":
        return this.renderFlatChildren(cmp);
      case "Author":
      case "Commit Hash":
      case "Moon Phase":
      case "Retrograde":
        return buildGroupedItems(cmp.id, cmp.repoFullPath, this.visibleFiles(cmp, cmp.files), cmp.groupingMode);
      case "File Structure":
      default:
        if (!cmp.tree) {
          return [new BranchCompareMessageItem("Loading…", "loading~spin")];
        }
        return this.renderFolderChildren(cmp, cmp.tree);
    }
  }

  /** Files still worth showing under `cmp` — everything, unless hideReviewed drops the reviewed ones. */
  private visibleFiles(cmp: ResolvedComparison, files: ChangedFile[]): ChangedFile[] {
    if (!cmp.hideReviewed) { return files; }
    return files.filter(f => !this.isReviewed(cmp.id, f.pathInRepo));
  }

  private renderFolderChildren(cmp: ResolvedComparison, node: FolderNode): BranchCompareTreeItem[] {
    const baseRef = cmp.target;

    const folders: BranchCompareFolderItem[] = [];
    for (const child of node.children.values()) {
      const allFilesInChild = collectFilesIn(child);
      const visibleInChild = this.visibleFiles(cmp, allFilesInChild);
      if (cmp.hideReviewed && visibleInChild.length === 0) { continue; }
      const reviewed = this.allReviewed(cmp.id, allFilesInChild);
      folders.push(new BranchCompareFolderItem(cmp.repoFullPath, child, visibleInChild.length, true, cmp.id, reviewed));
    }
    folders.sort((a, b) => a.label!.toString().localeCompare(b.label!.toString()));

    const files = sortFilesForGrouping(this.visibleFiles(cmp, node.files), this.sortOrder)
      .map(f => new BranchCompareFileItem(
        f, cmp.source, baseRef, cmp.id, cmp.diffMode, this.openChangesMode, this.isReviewed(cmp.id, f.pathInRepo),
      ));

    return [...folders, ...files];
  }

  private renderFlatChildren(cmp: ResolvedComparison): BranchCompareTreeItem[] {
    return sortFilesForGrouping(this.visibleFiles(cmp, cmp.files ?? []), this.sortOrder)
      .map(f => new BranchCompareFileItem(
        f, cmp.source, cmp.target, cmp.id, cmp.diffMode, this.openChangesMode, this.isReviewed(cmp.id, f.pathInRepo),
      ));
  }

  private renderGroupChildren(group: BranchCompareGroupItem): BranchCompareTreeItem[] {
    const cmp = this.comparisons.get(group.comparisonId);
    if (!cmp) { return []; }
    return sortFilesForGrouping(this.visibleFiles(cmp, group.files), this.sortOrder)
      .map(f => new BranchCompareFileItem(
        f, cmp.source, cmp.target, cmp.id, cmp.diffMode, this.openChangesMode, this.isReviewed(cmp.id, f.pathInRepo),
      ));
  }

  /** Active sort order — same shared store as Fresh Files, read on demand so we keep no local copy to sync. */
  private get sortOrder(): SortOrder {
    return WorkspaceStateManager.getSortOrder(ConfigService.getDefaultSortOrder());
  }

  /** Re-render after a sort-order change. Display-only — no data refetch. */
  rerenderForSortChange(): void {
    this.fireChange();
  }

  private fireChange(): void {
    this.updateContextKey();
    this._onDidChangeTreeData.fire();
  }

  private updateContextKey(): void {
    ContextManager.setBranchCompareHasActiveComparison(this.savedComparisons.hasAnyActive());
  }
}

/** Display-friendly ref name. `"HEAD"` becomes `"HEAD"`; empty becomes `"?"`. */
function displayRef(ref: string): string {
  return ref || "?";
}
