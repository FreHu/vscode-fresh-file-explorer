import * as vscode from "vscode";

import { BaselineService } from "../baseline/baselineService";
import { SavedComparisonsService, HEAD_SOURCE } from "./savedComparisonsService";
import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { log } from "../extension/logger";
import { resolveCommitTooltip } from "../utils/lazyCommitTooltip";
import { ContextManager } from "../extension/contextManager";
import { WorkspaceStateManager } from "../extension/workspaceStateManager";
import { ConfigService } from "../config/configService";
import { SortOrder } from "../types";
import {
  buildChangedFiles,
  buildFolderTree,
  collectFilesIn,
  newestChangeDate,
  changeDate,
  stampPendingMtimes,
  ChangedFile,
  fetchCommittedDiff,
  fetchCommitInfoInRange,
  countCommits,
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
import { defaultComparisonLabel, displayRef, emptyComparisonMessage } from "./comparisonLabel";
import { clampHeadOffsetRef } from "../git/gitCommitQueries";
import { FilesExcludeFilter } from "../fresh-files/filesExcludeFilter";
import { plural } from "../utils/plural";
import { sortTreeEntries } from "../utils/treeEntrySort";
import * as path from "path";

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
  /** Commits on target but not source; fetched only when the diff is empty, for its message. */
  targetOnlyCommits: number | undefined;
  /** Set when the target is a `HEAD~N` past the root commit: the commits that exist (the diff covers all of them). */
  availableCommits?: number;
  /** Per-comparison grouping mode, resolved from the saved record (default applied). */
  groupingMode: GroupingMode;
  /** Per-comparison diff mode — `merge` (vs merge-base) or `full` (vs target ref). */
  diffMode: DiffMode;
  /**
   * Whether the last successful load fetched commit info. Drives the lazy
   * re-fetch when grouping switches into a mode that needs commit metadata
   * (Author / Commit Hash / Moon Phase) but the cached files
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
  /** Per-comparison "Collapse All" counter; see `collapseSection`. */
  private readonly collapseEpochs = new Map<string, number>();

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
            this.refetchMissingCommitInfo(event.ids);
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
        // refChanged events are saved-comparison changes bubbled through; the
        // subscription above already handles those.
        if (event.refChanged) { return; }
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

    this.subscriptions.push(
      this.freshFileProvider.generatedFiles.onDidChange(() => this.applyFileFilterChange()),
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

  resolveTreeItem(item: vscode.TreeItem, element: BranchCompareTreeItem): Promise<vscode.TreeItem> {
    return resolveCommitTooltip(item, element instanceof BranchCompareGroupItem ? element.repoFullPath : undefined);
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
   *
   * The unbounded Promise.all is deliberate: branchCompareRefreshBenchmark
   * showed a concurrency cap slows large repos (up to 2×) without helping
   * small ones. Re-measure before adding one.
   */
  async refreshAll(): Promise<void> {
    if (!this.freshFileProvider.areReposReady) {
      log("branchCompare: refreshAll deferred — waiting for repo discovery");
      return;
    }
    this.syncComparisonsToService();
    const ids = [...this.comparisons.keys()];
    log(`branchCompare: refreshAll loading ${plural(ids.length, "comparison")}`);
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
      cmp.targetOnlyCommits = undefined;
      cmp.availableCommits = undefined;
      this.fireChange();
    }

    const myToken = (this.loadingTokens.get(id) ?? 0) + 1;
    this.loadingTokens.set(id, myToken);

    try {
      const sourceRef = cmp.source;
      // The base everything diffs against. `full` mode diffs the target ref
      // directly (exact target..source delta); `merge` mode diffs against the
      // merge-base (PR-style — what source adds since diverging). Full mode
      // needs no merge-base, saving a git call. A HEAD~N past the root commit
      // diffs against the empty tree in either mode.
      const clamped = await clampHeadOffsetRef(cmp.repoFullPath, cmp.target);
      const base = cmp.diffMode === "full" || clamped.availableCommits !== undefined
        ? clamped.ref
        : await this.baselineService.getMergeBase(cmp.repoFullPath, cmp.target, sourceRef);
      if (this.loadingTokens.get(id) !== myToken) return;

      // Working-tree overlay only applies when source === HEAD. Other source
      // refs aren't necessarily checked out — their working tree isn't ours.
      const includeWorkingTree = sourceRef === HEAD_SOURCE;
      const wantsCommitInfo = this.needsCommitInfo(cmp.groupingMode);

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

      const rawFiles = buildChangedFiles(cmp.repoFullPath, committed, workingTree, commitInfo, workingTreeNumstat);
      await stampPendingMtimes(rawFiles);
      void this.freshFileProvider.generatedFiles.classify(
        normalizePath(cmp.repoFullPath), rawFiles.map(f => normalizePath(`${cmp.repoFullPath}/${f.pathInRepo}`)));
      const files = this.filterHiddenFiles(cmp.repoFullPath, rawFiles);
      // Only an empty diff needs the reverse count: it decides the empty-section message.
      const targetOnlyCommits = files.length === 0 && mergeCone?.total === 0
        ? await countCommits(cmp.repoFullPath, `${sourceRef}..${cmp.target}`)
        : undefined;
      if (this.loadingTokens.get(id) !== myToken) return;

      cmp.rawFiles = rawFiles;
      cmp.files = files;
      cmp.tree = buildFolderTree(cmp.files);
      cmp.error = undefined;
      cmp.mergeCone = mergeCone;
      cmp.targetOnlyCommits = targetOnlyCommits;
      cmp.availableCommits = clamped.availableCommits;
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
      cmp.targetOnlyCommits = undefined;
      cmp.availableCommits = undefined;
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
   * Label generated files, and drop files hidden by their owning workspace
   * folder's `files.exclude` or by hideGeneratedFiles. Each comparison is rooted
   * at one repo, so — unlike the Fresh Files tree, which renders the same file
   * under multiple overlapping-root nodes — a file here has exactly one owning
   * folder, making this the owner-based check rather than a per-node one.
   */
  private filterHiddenFiles(repoFullPath: AbsolutePath, files: ChangedFile[]): ChangedFile[] {
    const generated = this.freshFileProvider.generatedFiles;
    const hideGenerated = ConfigService.getHideGeneratedFiles();
    const folders = this.freshFileProvider.workspaceFolders;
    return files.filter(f => {
      const absPath = normalizePath(`${repoFullPath}/${f.pathInRepo}`);
      f.generated = generated.isGenerated(absPath) || undefined;
      if (f.generated && hideGenerated) { return false; }
      return !(this.filesExcludeFilter.enabled && this.filesExcludeFilter.isExcludedByOwner(absPath, folders));
    });
  }

  /**
   * React to a change in what's hidden (`files.exclude`, its respect toggle,
   * hideGeneratedFiles, a file's generated status): drop compiled matchers and
   * re-derive each comparison's filtered files/tree from the cached raw diff — no git I/O.
   */
  applyFileFilterChange(): void {
    this.filesExcludeFilter.invalidate();
    for (const cmp of this.comparisons.values()) {
      if (cmp.rawFiles === undefined) { continue; }
      cmp.files = this.filterHiddenFiles(cmp.repoFullPath, cmp.rawFiles);
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
        if (file.isPending) {
          // Already stat'ed this refresh; a deletion has no mtime and drops the mark.
          if (file.modifiedAt?.getTime() !== recordedMtime) {
            map.delete(path);
            changed = true;
          }
          return;
        }
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

  /** Grouping by author / commit / phase, or sorting by date / author, reads each file's last commit. */
  private needsCommitInfo(mode: GroupingMode): boolean {
    return mode === "Author" || mode === "Commit Hash" || mode === "Moon Phase"
      || this.sortOrder === "date" || this.sortOrder === "author";
  }

  /** Re-fetches the comparisons whose cached load lacks commit info they now need. */
  private refetchMissingCommitInfo(ids: Iterable<string>): void {
    for (const id of ids) {
      const cmp = this.comparisons.get(id);
      if (cmp?.files && cmp.files.length > 0 && this.needsCommitInfo(cmp.groupingMode) && !cmp.hasCommitInfo) {
        void this.refreshComparison(id, true);
      }
    }
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
          existing.targetOnlyCommits = undefined;
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
          existing.targetOnlyCommits = undefined;
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
          targetOnlyCommits: undefined,
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
        : defaultComparisonLabel(cmp.repoName, cmp.source, cmp.target);
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
          this.freshFileProvider.getRepoKind(repoKey),
          cmp.availableCommits,
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
      // Source has no commits past the base, so the diff is empty by construction:
      // say whether it's the same commit (a fresh branch) or behind the target.
      if (cmp.mergeCone && cmp.mergeCone.total === 0) {
        const { label, tooltip } = emptyComparisonMessage(cmp.source, cmp.target, cmp.targetOnlyCommits);
        return [new BranchCompareMessageItem(label, "info", tooltip)];
      }
      return [new BranchCompareMessageItem(
        `No changes (${displayRef(cmp.source)}..${displayRef(cmp.target)})`,
        "check",
      )];
    }

    if (cmp.hideReviewed && this.visibleFiles(cmp, cmp.files).length === 0) {
      return [new BranchCompareMessageItem(`All ${plural(cmp.files.length, "changed file")} reviewed`, "check")];
    }

    switch (cmp.groupingMode) {
      case "Flat List":
        return this.renderFlatChildren(cmp);
      case "Author":
      case "Commit Hash":
      case "Moon Phase":
        return buildGroupedItems(
          cmp.id, cmp.repoFullPath, this.visibleFiles(cmp, cmp.files), cmp.groupingMode, this.sortOrder,
          ConfigService.getDescriptionFormat(), this.collapseEpochs.get(cmp.id),
        );
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
    const items: (BranchCompareFolderItem | BranchCompareFileItem)[] = this.fileItems(cmp, node.files);
    const folderDates = new Map<BranchCompareFolderItem, Date | undefined>();
    for (const child of node.children.values()) {
      const allFilesInChild = collectFilesIn(child);
      const visibleInChild = this.visibleFiles(cmp, allFilesInChild);
      if (cmp.hideReviewed && visibleInChild.length === 0) { continue; }
      const reviewed = this.allReviewed(cmp.id, allFilesInChild);
      const folder = new BranchCompareFolderItem(
        cmp.repoFullPath, child, visibleInChild.length, cmp.id, reviewed, this.collapseEpochs.get(cmp.id),
      );
      folderDates.set(folder, newestChangeDate(visibleInChild));
      items.push(folder);
    }
    sortTreeEntries(items, this.sortOrder, {
      name: item => item instanceof BranchCompareFolderItem ? item.label!.toString() : path.posix.basename(item.file.pathInRepo),
      isDirectory: item => item.isDirectory,
      date: item => item instanceof BranchCompareFolderItem ? folderDates.get(item) : changeDate(item.file),
      author: item => item instanceof BranchCompareFolderItem ? "" : item.file.commit?.author ?? "",
    });
    return items;
  }

  private renderFlatChildren(cmp: ResolvedComparison): BranchCompareTreeItem[] {
    return this.fileItems(cmp, cmp.files ?? []);
  }

  private renderGroupChildren(group: BranchCompareGroupItem): BranchCompareTreeItem[] {
    const cmp = this.comparisons.get(group.comparisonId);
    if (!cmp) { return []; }
    return this.fileItems(cmp, group.files);
  }

  /** Visible, sorted file rows for `files` under `cmp`. */
  private fileItems(cmp: ResolvedComparison, files: ChangedFile[]): BranchCompareFileItem[] {
    const iconStyle = ConfigService.getBranchCompareFileIcons();
    return sortFilesForGrouping(this.visibleFiles(cmp, files), this.sortOrder)
      .map(f => new BranchCompareFileItem(
        f, cmp.source, cmp.target, cmp.id, cmp.diffMode, this.openChangesMode,
        this.isReviewed(cmp.id, f.pathInRepo), iconStyle,
      ));
  }

  /** Active sort order — same shared store as Fresh Files, read on demand so we keep no local copy to sync. */
  private get sortOrder(): SortOrder {
    return WorkspaceStateManager.getSortOrder(ConfigService.getDefaultSortOrder());
  }

  /** Re-render after a display setting change (sort order, description format). No data refetch. */
  rerender(): void {
    this.refetchMissingCommitInfo(this.comparisons.keys());
    this.fireChange();
  }

  /**
   * Collapse every folder / group under one section, leaving the section open.
   * Bumps the comparison's collapse epoch so those nodes re-render collapsed
   * under new ids (see `collapseEpochSuffix`). No data refetch.
   */
  collapseSection(comparisonId: string): void {
    this.collapseEpochs.set(comparisonId, (this.collapseEpochs.get(comparisonId) ?? 0) + 1);
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
