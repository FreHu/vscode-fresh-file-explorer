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
  countFilesIn,
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

      cmp.files = buildChangedFiles(cmp.repoFullPath, committed, workingTree, commitInfo, workingTreeNumstat);
      cmp.tree = buildFolderTree(cmp.files);
      cmp.error = undefined;
      cmp.mergeCone = mergeCone;
      cmp.hasCommitInfo = wantsCommitInfo;
    } catch (err) {
      if (this.loadingTokens.get(id) !== myToken) return;
      cmp.error = String(err);
      cmp.invalidRef = isInvalidRefError(err);
      cmp.files = [];
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
          existing.tree = undefined;
          existing.error = undefined;
          existing.invalidRef = false;
          existing.mergeCone = undefined;
        }
        existing.label = sc.label;
        existing.repoName = repoInfo.repoName;
        existing.groupingMode = sc.groupingMode;
        // diffMode change invalidates the diff — drop cached files so it reloads.
        if (existing.diffMode !== sc.diffMode) {
          existing.diffMode = sc.diffMode;
          existing.files = undefined;
          existing.tree = undefined;
          existing.error = undefined;
          existing.invalidRef = false;
          existing.mergeCone = undefined;
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
          tree: undefined,
          error: undefined,
          invalidRef: false,
          mergeCone: undefined,
          groupingMode: sc.groupingMode,
          diffMode: sc.diffMode,
          hasCommitInfo: false,
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
      const currentBranch = this.freshFileProvider.getRepoBranch(repoKey);
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

    switch (cmp.groupingMode) {
      case "Flat List":
        return this.renderFlatChildren(cmp);
      case "Author":
      case "Commit Hash":
      case "Moon Phase":
      case "Retrograde":
        return buildGroupedItems(cmp.id, cmp.repoFullPath, cmp.files, cmp.groupingMode);
      case "File Structure":
      default:
        if (!cmp.tree) {
          return [new BranchCompareMessageItem("Loading…", "loading~spin")];
        }
        return this.renderFolderChildren(cmp, cmp.tree);
    }
  }

  private renderFolderChildren(cmp: ResolvedComparison, node: FolderNode): BranchCompareTreeItem[] {
    const baseRef = cmp.target;

    const folders: BranchCompareFolderItem[] = [];
    for (const child of node.children.values()) {
      const count = countFilesIn(child);
      folders.push(new BranchCompareFolderItem(cmp.repoFullPath, child, count, true, cmp.id));
    }
    folders.sort((a, b) => a.label!.toString().localeCompare(b.label!.toString()));

    const files = sortFilesForGrouping(node.files, this.sortOrder)
      .map(f => new BranchCompareFileItem(f, cmp.source, baseRef, cmp.id, cmp.diffMode, this.openChangesMode));

    return [...folders, ...files];
  }

  private renderFlatChildren(cmp: ResolvedComparison): BranchCompareTreeItem[] {
    return sortFilesForGrouping(cmp.files ?? [], this.sortOrder).map(f => new BranchCompareFileItem(f, cmp.source, cmp.target, cmp.id, cmp.diffMode, this.openChangesMode));
  }

  private renderGroupChildren(group: BranchCompareGroupItem): BranchCompareTreeItem[] {
    const cmp = this.comparisons.get(group.comparisonId);
    if (!cmp) { return []; }
    return sortFilesForGrouping(group.files, this.sortOrder).map(f => new BranchCompareFileItem(f, cmp.source, cmp.target, cmp.id, cmp.diffMode, this.openChangesMode));
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
