import * as vscode from "vscode";
import * as path from "path";

import { ConfigService } from "../config/configService";
import { ConfigKeys } from "../config/configKeyConstants";
import { HistoricalFileCache, type CacheRepoStats } from "./historicalFileCache";
import { FileIndex } from "./fileIndex";
import { RefreshEpochGuard, RefreshCancelledError } from "./refreshEpochGuard";
import { RepoScopeStore } from "./repoScopeStore";
export type { CacheRepoStats };
import {
  WorkspaceFolderInfo,
  FileMetadata,
  AuthorData,
  BranchName,
  CommitHash,
  CommitAuthor,
  CommitStats,
  asCommitAuthor,
  CommitDataWithFileCount,
  asCommitMessage,
  SortOrder,
} from "../types";
import { buildTimeWindows, isPendingChangesMode, TimeWindow } from "./timeWindowUtils";
import { AbsolutePath, asAbsolutePath } from "../pathTypes";
import { formatFileDescription, formatFileTooltip, formatDirectoryTooltip, formatGroupDescription } from "../utils/formatUtils";
import { log, showWarning } from "../extension/logger";
import { FreshFileItem, MessageTreeItem as MessageTreeItem, FreshFilesTreeItem, SubmoduleEntryItem, UninitializedSubmodulesGroupItem, UninitializedSubmoduleItem, isAuthorGroup, isCommitHashGroup, isMoonPhaseGroup, isRetrogradeGroup } from "./freshFileTreeItems";
import { normalizePath } from "../utils";
import { GroupingMode, DEFAULT_GROUPING_MODE } from "./groupingMode";
import { type MoonPhase } from "./moonPhase";
import { clearRetrogradeCache } from "./planetaryRetrograde";
import { FilterManager } from "./freshFileFilterManager";
import { GroupingViewBuilder } from "./groupingViewBuilder";
import { DataCollector, RepoInfo } from "./dataCollector";
import { NormalizedRepoPath } from "../pathTypes";
import { findWorkspaceFolderForPath, findRepoForFile, getRelativeDepth } from "../utils/pathUtils";
import { FreshFileItemSorter } from "./freshFileItemSorter";
import { ContextManager } from "../extension/contextManager";
import { WorkspaceStateManager } from "../extension/workspaceStateManager";

export class FreshFileProvider implements vscode.TreeDataProvider<FreshFilesTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<FreshFilesTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /**
   * Fires every time repo discovery transitions to "done" — initial activation
   * and after any subsequent `hardRefresh()`. Lets dependent features (e.g. the
   * blame heatmap auto-apply) wait until `findRepoForAbsolutePath` will actually
   * resolve before they try to attach to the active editor.
   */
  private _onReposReady = new vscode.EventEmitter<void>();
  readonly onReposReady = this._onReposReady.event;
  get areReposReady(): boolean { return this.reposDiscovered; }

  /**
   * Snapshot of where loading currently sits — drives the fresh-files status
   * bar entry. Listeners react via `onDidChangeTreeData` (already fired at
   * every state transition); this getter just packages the relevant flags.
   *
   * - `discovering` — repo discovery still in flight.
   * - `loading` — repos discovered, files (pending and/or historical) loading.
   * - `idle`       — caught up. `totalRepos` may be 0 when the workspace has none.
   */
  getLoadingProgress(): { state: "discovering" | "loading" | "idle"; totalRepos: number; loadedRepos: number } {
    if (!this.reposDiscovered) {
      return { state: "discovering", totalRepos: 0, loadedRepos: 0 };
    }
    const totalRepos = this.totalRepoCount;
    const stillLoading = this.reposLoading.size + this.reposLoadingHistorical.size;
    if (stillLoading > 0) {
      // A single repo can sit in both sets simultaneously — clamp so the count
      // doesn't briefly exceed totalRepos during the pending→historical handoff.
      const loadedRepos = Math.max(0, totalRepos - Math.min(stillLoading, totalRepos));
      return { state: "loading", totalRepos, loadedRepos };
    }
    return { state: "idle", totalRepos, loadedRepos: totalRepos };
  }

  // Map of absolute file path to file metadata
  private _freshFiles: Map<AbsolutePath, FileMetadata> = new Map();
  get freshFiles(): Map<AbsolutePath, FileMetadata> { return this._freshFiles; }

  // Path index + per-render dir-stats cache.
  private fileIndex = new FileIndex();
  currentTimeWindow: TimeWindow;
  timeWindows: TimeWindow[];
  // Multi-root workspace support
  workspaceFolders: WorkspaceFolderInfo[] = [];
  private errorToShowInTreeView: string | undefined;
  private refreshPromise: Promise<void> | undefined;
  private _dataLoaded: boolean = false;
  /**
   * Whether file data is loaded and usable. Exact inverse of the `freshFileExplorer.loading` context key
   */
  private get dataLoaded(): boolean { return this._dataLoaded; }
  private set dataLoaded(value: boolean) {
    this._dataLoaded = value;
    ContextManager.setLoading(!value);
  }
  get isDataLoaded(): boolean { return this._dataLoaded; }
  // Set to true once git repos have been discovered (before file loading completes)
  private reposDiscovered: boolean = false;
  // Normalized absolute paths of repos whose initial (pending) file loading is still in progress
  private reposLoading: Set<NormalizedRepoPath> = new Set();
  // Normalized absolute paths of repos that have pending files loaded but historical is still running
  private reposLoadingHistorical: Set<NormalizedRepoPath> = new Set();
  // Bumped on every refresh() so in-flight updateFreshFiles calls can detect staleness
  private readonly refreshGuard = new RefreshEpochGuard();

  // Sync status warnings
  private syncWarnings: string[] = [];

  // Branch names for repositories (from Git extension API)
  private repoBranches: Map<NormalizedRepoPath, BranchName> = new Map();

  // Heatmap decoration provider (set by extension.ts after construction)
  heatmapProvider?: { fireDidChange: () => void };

  // Tree view reference (set by extension.ts after construction)
  private treeView?: vscode.TreeView<FreshFilesTreeItem>;

  // Grouping mode - persisted
  groupingMode: GroupingMode = DEFAULT_GROUPING_MODE;

  // Sort order - persisted
  sortOrder: SortOrder = "name";

  // Open mode toggle - persisted
  openChangesMode: boolean = false;

  // Managers for specific concerns
  readonly filterManager = new FilterManager();

  // Incremented every time refreshPending() runs, so external listeners can detect
  // that a pending refresh already happened and skip scheduling a duplicate.
  pendingRefreshVersion: number = 0;

  // Per-repo scoping state: git pathspec (restricts a repo's `git log`) and
  // folder scope (display-only narrowing). Owns its own persistence.
  private readonly repoScope = new RepoScopeStore();

  // Target repo paths for the current refresh (undefined = all repos).
  // Set by refresh() to scope updateFreshFiles() to only specific repos.
  private _targetRepoPaths: NormalizedRepoPath[] | undefined = undefined;

  // Cached resolved repo list, populated after discovery and cleared on hard refresh.
  // Contains only scannable repos — uninitialized submodules are held separately.
  private _resolvedRepos: RepoInfo[] = [];

  // Uninitialized (not-checked-out) submodules, kept for display only. Deliberately
  // excluded from _resolvedRepos and folder.gitRepos so no scan path ever touches them.
  private _uninitializedSubmodules: RepoInfo[] = [];

  // Cache of the most-recently returned repo root FreshFileItem instances, keyed by id.
  // Populated in buildRepoView so revealSubmoduleRepo can pass the exact same object
  // instances that VS Code already registered (reveal() rejects freshly constructed duplicates).
  private _repoItemCache: Map<string, FreshFileItem> = new Map();

  readonly historicalCache = new HistoricalFileCache();

  constructor() {
    this.initializeWorkspaceFolders();
    this.timeWindows = this.loadTimeWindows();
    this.currentTimeWindow = this.timeWindows[0]; // Will be overridden by persisted value

    // Set initial context - we're loading
    ContextManager.setLoading(true);
  }

  initializeWorkspaceFolders(): void {
    const folders = vscode.workspace.workspaceFolders || [];
    this.workspaceFolders = folders.map(folder => ({
      path: asAbsolutePath(folder.uri.fsPath),
      name: folder.name,
      gitRepos: [],
    }));
  }

  /** Shows warning if workspace folders are empty. If warning was shown, returns true */
  warnIfNoWorkspaceFolders(): boolean {
    const workspaceFolders = this.workspaceFolders;
    if (workspaceFolders.length === 0) {
      showWarning("No workspace folder open");
      return true;
    }

    return false;
  }

  /**
   * Initialize managers and load persisted settings.
   * Must be called after WorkspaceStateManager.initialize().
   */
  initialize(): void {
    // Initialize managers
    this.filterManager.initialize(() => this.refreshTreeOnly());

    // Load persisted time window selection
    const persistedDays = WorkspaceStateManager.getSelectedTimeWindowDays();
    this.openChangesMode = WorkspaceStateManager.getOpenChangesMode(ConfigService.getDefaultOpenChangesMode());
    this.groupingMode = WorkspaceStateManager.getGroupingMode(ConfigService.getDefaultGroupingMode());
    this.sortOrder = WorkspaceStateManager.getSortOrder(ConfigService.getDefaultSortOrder());

    this.repoScope.load();

    // Set initial context for when clause
    ContextManager.setOpenChangesMode(this.openChangesMode);

    if (persistedDays !== undefined) {
      const found = this.timeWindows.find(tw => tw.type === "historical" && tw.days === persistedDays);
      this.currentTimeWindow = found || this.timeWindows[0];
    } else {
      // Default to 1 month if available, otherwise first historical option
      const defaultWindow =
        this.timeWindows.find(tw => tw.type === "historical" && tw.days === 30) ||
        this.timeWindows.find(tw => tw.type === "historical") ||
        this.timeWindows[0];
      this.currentTimeWindow = defaultWindow;
    }
  }

  private loadTimeWindows(): TimeWindow[] {
    const dayValues = ConfigService.getTimeWindowDays();
    return buildTimeWindows(dayValues);
  }

  onConfigurationChanged(e: vscode.ConfigurationChangeEvent): void {
    // autoStageRename is behavioral-only — skip tree refresh when it's the sole change.
    if (e.affectsConfiguration(ConfigKeys.AUTO_STAGE_RENAME)) {
      const otherKeyChanged = Object.values(ConfigKeys)
        .filter(k => k !== ConfigKeys.AUTO_STAGE_RENAME)
        .some(k => e.affectsConfiguration(k));
      if (!otherKeyChanged) {
        return;
      }
    }

    log("Configuration changed, hard refreshing");

    // When the default for a workspace-persisted setting changes, clear the saved
    // value so the new default takes effect immediately.
    if (e.affectsConfiguration(ConfigKeys.DEFAULT_GROUPING_MODE)) {
      WorkspaceStateManager.clearGroupingMode();
      this.groupingMode = ConfigService.getDefaultGroupingMode();
    }
    if (e.affectsConfiguration(ConfigKeys.DEFAULT_SORT_ORDER)) {
      WorkspaceStateManager.clearSortOrder();
      this.sortOrder = ConfigService.getDefaultSortOrder();
    }

    this.timeWindows = this.loadTimeWindows();
    // If the current window was removed from the configured list, fall back to another one.
    const currentStillValid = this.timeWindows.find(tw => {
      if (tw.type === "pending" && this.currentTimeWindow.type === "pending") { return true; }
      return tw.type === "historical" && this.currentTimeWindow.type === "historical" && tw.days === this.currentTimeWindow.days;
    });
    if (!currentStillValid) {
      this.currentTimeWindow = this.timeWindows.length > 1 ? this.timeWindows[1] : this.timeWindows[0];
    }

    
    // Map each setting to the cheapest refresh that makes its change visible.
    // "none"        — handled outside freshFileProvider (heatmap, git timeout, etc.)
    // "treeOnly"    — re-render from cached data; no git I/O
    // "pending"     — re-run git status + numstat; rebuilds from cached history baseline
    // "hard"        — full repo discovery + git log; only when history scope changes
    type RefreshAction = "none" | "treeOnly" | "pending" | "hard";
    
    //prettier-ignore
    const CONFIG_ACTIONS: Record<keyof typeof ConfigKeys, RefreshAction> = {
      // History scope — must re-fetch git log data.
      TIME_WINDOWS:                    "hard",

      // Pending-path data — gates a git diff --numstat call.
      DESCRIPTION_SHOW_LINE_CHANGES:   "pending",

      // Display-only — all data is already cached.
      DESCRIPTION_SHOW_DATE:           "treeOnly",
      DESCRIPTION_SHOW_AUTHOR:         "treeOnly",
      DESCRIPTION_SHOW_COMMIT_HASH:    "treeOnly",
      DESCRIPTION_SHOW_COMMIT_MESSAGE: "treeOnly",
      DESCRIPTION_SHOW_STATUS:         "treeOnly",
      DEFAULT_GROUPING_MODE:           "treeOnly",
      DEFAULT_SORT_ORDER:              "treeOnly",
      FLAT_LIST_LABEL_STYLE:           "treeOnly",
      AUTO_EXPAND_DEPTH:               "treeOnly",
      SHOW_CURRENT_BRANCH_SYNC:        "treeOnly",
      SHOW_BASE_BRANCH_SYNC:           "treeOnly",
      INCREMENTAL_TREE_LOADING:        "treeOnly",

      // Handled elsewhere or behavioural only — no tree refresh needed.
      HEATMAP_ENABLED:                 "none",
      BLAME_HEATMAP_AUTO_APPLY:        "none",
      BLAME_HEATMAP_BG_OPACITY:        "none",
      BLAME_HEATMAP_MAX_LINES:         "none",
      AUTO_REVEAL:                     "none",
      GIT_TIMEOUT:                     "none",
      SEARCH_PATTERN_MAX_LENGTH:       "none",
      OPEN_SEARCH_IN_EDITOR:           "none",
      CODE_TELESCOPE_INTEGRATION:      "none",
      DEFAULT_OPEN_CHANGES_MODE:       "none",
      AUTO_STAGE_RENAME:               "none",
      STATUS_BAR_LOADING:              "none",
      STATUS_BAR_HEATMAP:              "none",
      BRANCH_COMPARE_WORKING_TREE_SIDE: "none",
      BULK_ACTION_CONFIRM_THRESHOLD:    "none",
      NOTIFY_ON:                       "none",
    };

    let action: RefreshAction = "none";
    for (const [key, candidate] of Object.entries(CONFIG_ACTIONS) as [keyof typeof ConfigKeys, RefreshAction][]) {
      if (!e.affectsConfiguration(ConfigKeys[key])) continue;
      // Escalate to the most expensive action required by any changed key.
      if (candidate === "hard" || (candidate === "pending" && action !== "hard") || (candidate === "treeOnly" && action === "none")) {
        action = candidate;
      }
    }

    switch (action) {
      case "hard":
        log("Configuration changed: time windows — running full refresh");
        this.hardRefresh();
        break;
      case "pending":
        log("Configuration changed: showLineChanges — refreshing pending");
        void this.refreshPending();
        break;
      case "treeOnly":
        log("Configuration changed: display setting — re-rendering tree");
        this.refreshTreeOnly();
        break;
      case "none":
        // No freshFileProvider-side action needed. Handled elsewhere or purely behavioural.
        break;
      default: {
        // Exhaustiveness guard — `never` makes TypeScript fail compile if a
        // new RefreshAction variant is added without a case here.
        const _exhaustive: never = action;
        throw new Error(`Unhandled RefreshAction: ${_exhaustive}`);
      }
    }
  }

  /**
   * Soft refresh: reload files from the already-known set of repositories.
   * Skips repo discovery.
   * Falls back to hardRefresh() if repos have never been discovered yet.
   * @param preserveHistoricalCache When true, the historical cache is kept intact (e.g. time-window display switch).
   */
  refresh(options?: { preserveHistoricalCache?: boolean; targetRepoPaths?: NormalizedRepoPath[] }): void {
    if (!this.reposDiscovered) {
      this.hardRefresh();
      return;
    }
    const targetRepoPaths = options?.targetRepoPaths;
    const scopeDesc = targetRepoPaths ? ` [${targetRepoPaths.length} repo(s)]` : "";
    log(`Refresh of files in ${scopeDesc} with time window: ${this.currentTimeWindow.label}`);
    this.dataLoaded = false;
    this._targetRepoPaths = targetRepoPaths;
    this.refreshGuard.bump();
    clearRetrogradeCache();
    this.reposLoading.clear();
    this.reposLoadingHistorical.clear();
    if (targetRepoPaths) {
      // Targeted refresh: remove only affected repos' files, keep other repos intact.
      this._setFreshFiles(fileMapExcludingRepos(this._freshFiles, targetRepoPaths));
      if (options?.preserveHistoricalCache) {
        this.historicalCache.historicalFiles = fileMapExcludingRepos(this.historicalCache.historicalFiles, targetRepoPaths);
      } else {
        this.historicalCache.clearForRepos(targetRepoPaths);
      }
      // Show spinner only for target repos.
      for (const repoPath of targetRepoPaths) {
        this.reposLoading.add(repoPath);
      }
    } else {
      this._setFreshFiles(new Map());
      if (options?.preserveHistoricalCache) {
        this.historicalCache.historicalFiles = new Map();
      } else {
        this.historicalCache.clear();
      }
      // Pre-populate reposLoading so spinner appears on each repo node immediately.
      for (const { normalizedRepoPath } of this.resolvedRepos) {
        this.reposLoading.add(normalizedRepoPath);
      }
    }
    this._onDidChangeTreeData.fire();
    // Drive the load ourselves — relying on getChildren() to kick it off leaves
    // the status bar stuck on "Loading X/Y" when the view is hidden at the moment
    // refresh() runs (e.g. branch switch with focus elsewhere).
    this.kickOffLoad();
  }

  /**
   * Hard refresh: re-discover repositories then reload all files.
   * Use this when the repo list may have changed (refresh button, workspace folder change).
   */
  hardRefresh(): void {
    log(`Hard refresh (repo discovery + history) with time window: ${this.currentTimeWindow.label}`);
    this.dataLoaded = false;
    this.reposDiscovered = false;
    this._resolvedRepos = [];
    this._uninitializedSubmodules = [];
    this._repoItemCache.clear();
    this.reposLoading.clear();
    this.reposLoadingHistorical.clear();
    this.refreshGuard.bump();
    this._setFreshFiles(new Map());
    this.historicalCache.clear();
    clearRetrogradeCache();
    this._onDidChangeTreeData.fire();
    this.kickOffLoad();
  }

  /**
   * Start `updateFreshFiles()` if no load is already in flight. Includes a
   * re-kick when the in-flight load was cancelled (refreshEpoch bumped mid-load)
   * — without this, the new state set by the cancelling refresh() would never
   * actually be loaded.
   */
  private kickOffLoad(): void {
    if (this.refreshPromise) { return; }
    this.refreshPromise = this.updateFreshFiles().finally(() => {
      this.refreshPromise = undefined;
      if (!this.dataLoaded) {
        log("Stale load detected after promise settled — starting new load");
        this.refreshPromise = this.updateFreshFiles().finally(() => {
          this.refreshPromise = undefined;
        });
      }
    });
  }

  /** Refresh the tree display without reloading data from git */
  refreshTreeOnly(): void {
    this.fileIndex.invalidateStats(); // filters/scopes may have changed
    this._onDidChangeTreeData.fire();
  }

  /**
   * Refresh only the pending layer, leaving historical data cached.
   * Used when working-tree or index changes are detected but no full refresh is required (e.g. new file created).
   * Falls back to a full refresh if data hasn't been loaded yet.
   */
  async refreshPending(targetRepoPaths?: NormalizedRepoPath[]): Promise<void> {
    if (!this.dataLoaded) {
      this.refresh(); // soft if repos known, hard if first load
      return;
    }
    this.pendingRefreshVersion++;
    const scopeDesc = targetRepoPaths ? ` for ${targetRepoPaths.length} repo(s)` : "";
    log(`Refreshing pending changes only${scopeDesc}`);
    try {
      await this.updatePendingFiles(targetRepoPaths);
      this._onDidChangeTreeData.fire();
    } catch (e) {
      // Callers fire-and-forget this (`void`), so a rejection here would be an
      // unhandled rejection with no handler. Log and swallow: a failed pending
      // refresh just leaves the tree showing its last-known state.
      log(`refreshPending failed${scopeDesc}: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  private async updatePendingFiles(targetRepoPaths?: NormalizedRepoPath[]): Promise<void> {
    if (this.workspaceFolders.length === 0) {
      return;
    }

    if (targetRepoPaths) {
      // Targeted update: only query the repos that changed.
      const targetFolders = buildTargetWorkspaceFolders(this.workspaceFolders, targetRepoPaths);
      const { files: pendingFiles, removedPaths } = await DataCollector.collectPendingFiles(targetFolders);

      // Merge strategy:
      // 1. Historical baseline for target repos (reset to committed state).
      // 2. Current freshFiles entries for non-target repos (preserve their state).
      // 3. Fresh pending entries for target repos (override historical baseline).
      // 4. Remove paths from renames (old paths that no longer exist).
      const merged = new Map<AbsolutePath, FileMetadata>();
      for (const [absPath, metadata] of this.historicalCache.historicalFiles) {
        if (fileInTargetRepo(absPath, targetRepoPaths)) {
          merged.set(absPath, metadata);
        }
      }
      for (const [absPath, metadata] of this._freshFiles) {
        if (!fileInTargetRepo(absPath, targetRepoPaths)) {
          merged.set(absPath, metadata);
        }
      }
      for (const [absPath, metadata] of pendingFiles) {
        merged.set(absPath, metadata);
      }
      for (const removed of removedPaths) {
        merged.delete(removed);
      }
      this._setFreshFiles(merged);
    } else {
      const { files: pendingFiles, removedPaths } = await DataCollector.collectPendingFiles(this.workspaceFolders);
      // Rebuild freshFiles from cached historical baseline + new pending entries.
      // This restores historical entries for files whose pending changes were reverted.
      const merged = new Map<AbsolutePath, FileMetadata>(this.historicalCache.historicalFiles);
      for (const [absolutePath, metadata] of pendingFiles) {
        merged.set(absolutePath, metadata);
      }
      for (const removed of removedPaths) {
        merged.delete(removed);
      }
      this._setFreshFiles(merged);
    }
  }

  setTimeWindow(timeWindow: TimeWindow): void {
    log(`Time window: ${this.currentTimeWindow.label} -> ${timeWindow.label}`);
    this.currentTimeWindow = timeWindow;
    this.filterManager.clearFilters();
    if (timeWindow.type === "historical") {
      WorkspaceStateManager.setSelectedTimeWindowDays(timeWindow.days);
      // Serve from cache if all repos have a valid cached result that covers this window.
      if (this.historicalCache.canServeWindow(timeWindow.days, this.workspaceFolders, this.repoScope.pathspecs)) {
        log(`Using cache to serve time window ${timeWindow.label}`);
        this.refreshGuard.bump(); // cancel any in-flight updateFreshFiles
        this.dataLoaded = true;
        this._setFreshFiles(this.historicalCache
          .applyWindowToFiles(timeWindow.days, this.workspaceFolders, this.freshFiles));
        this.refreshTreeOnly();
        return;
      }
      // An in-flight load always targets the maximum configured interval.
      // If there's a load in progress and it covers the new window, don't cancel it —
      // the incremental cache updates will apply the new window as each threshold is crossed.
      const configuredMaxDays = Math.max(0, ...this.historicalTimeWindows.map(tw => tw.days));
      if (this.refreshPromise && configuredMaxDays >= timeWindow.days) {
        log(`Time window set to ${timeWindow.label} — will be covered by in-flight load`);
        this.refreshTreeOnly();
        return;
      }
    } else if (timeWindow.type === "pending" && this.dataLoaded) {
      // Pending files are already present in freshFiles — no git operations needed.
      log(`Serving pending window from existing data`);
      this.refreshGuard.bump(); // cancel any in-flight updateFreshFiles
      this._setFreshFiles(this.historicalCache.applyPendingOnly(this.freshFiles));
      this.refreshTreeOnly();
      return;
    }
    this.refresh({ preserveHistoricalCache: true }); // soft — repos unchanged; keep cache for other windows
  }

  setOpenMode(value: boolean): void {
    if (value === this.openChangesMode) { return; }
    this.openChangesMode = value;
    log(`Set open mode: ${this.openChangesMode ? "changes" : "file"}`);

    WorkspaceStateManager.setOpenChangesMode(this.openChangesMode);
    ContextManager.setOpenChangesMode(this.openChangesMode);

    this.refreshTreeOnly();
  }

  setTreeView(treeView: vscode.TreeView<FreshFilesTreeItem>): void {
    this.treeView = treeView;
    this.updateGroupingModeMessage();
  }

  setGroupingMode(mode: GroupingMode): void {
    log(`Grouping mode changed from ${this.groupingMode} to ${mode}`);
    this.groupingMode = mode;

    WorkspaceStateManager.setGroupingMode(mode);
    this.updateGroupingModeMessage();

    this.refreshTreeOnly();
  }

  setSortOrder(order: SortOrder): void {
    log(`Sort order changed from ${this.sortOrder} to ${order}`);
    this.sortOrder = order;

    WorkspaceStateManager.setSortOrder(order);
    this.refreshTreeOnly();
  }

  /**
   * Set or clear the pathspec filter for a repository.
   * Pass undefined (or empty string) to remove the filter.
   * Triggers a refresh so git log is re-run with the new pathspec.
   */
  setRepoPathspec(normalizedRepoPath: NormalizedRepoPath, pathspec: string | undefined): void {
    const trimmed = pathspec?.trim();
    log(trimmed ? `Setting pathspec for ${normalizedRepoPath}: ${trimmed}` : `Clearing pathspec for ${normalizedRepoPath}`);
    this.repoScope.setPathspec(normalizedRepoPath, trimmed || undefined);
    this.refresh({ targetRepoPaths: [normalizedRepoPath] });
  }

  /** Return the active pathspec for a repo, or undefined if none is set. */
  getRepoPathspec(normalizedRepoPath: NormalizedRepoPath): string | undefined {
    return this.repoScope.getPathspec(normalizedRepoPath);
  }

  /**
   * Scope the display of a repo to a specific folder (display-only, no git reload).
   * Only files whose path starts with `normalizedFolderPath` will be shown.
   * Pass undefined to clear the scope.
   */
  setFolderScope(normalizedRepoPath: NormalizedRepoPath, normalizedFolderPath: string | undefined): void {
    log(normalizedFolderPath
      ? `Scoping repo ${normalizedRepoPath} to folder: ${normalizedFolderPath}`
      : `Clearing folder scope for repo ${normalizedRepoPath}`);
    this.repoScope.setFolderScope(normalizedRepoPath, normalizedFolderPath);
    this.refreshTreeOnly();
  }

  /** Return the active folder scope for a repo, or undefined if none is set. */
  getFolderScope(normalizedRepoPath: NormalizedRepoPath): string | undefined {
    return this.repoScope.getFolderScope(normalizedRepoPath);
  }

  /**
   * Returns true if the file passes the folder scope filter for its repo.
   * When no scope is active for the repo, all files pass.
   */
  private passesRepoScope(normalizedFilePath: string): boolean {
    return this.repoScope.passesScope(normalizedFilePath, this.resolvedRepos);
  }

  private updateGroupingModeMessage(): void {
    if (!this.treeView) {
      return;
    }
    if (this.groupingMode === "File Structure" || this.groupingMode === "Flat List") {
      this.treeView.message = undefined;
    } else {
      this.treeView.message =
        "Only the most recent commit per file is examined. " +
        "If a file was modified multiple times in " +
        "this period, the latest change is shown.";
    }
  }

  /** Get list of unique authors from current files */
  getAvailableAuthors(): AuthorData[] {
    const authorCounts = new Map<CommitAuthor, number>();
    for (const metadata of this.freshFiles.values()) {
      const author = asCommitAuthor(metadata.author || "(unknown)");
      authorCounts.set(author, (authorCounts.get(author) || 0) + 1);
    }
    return Array.from(authorCounts.entries())
      .map(([author, fileCount]) => ({ author, fileCount }))
      .sort((a, b) => b.fileCount - a.fileCount); // Sort by file count descending
  }

  /** Get list of unique commits from current files */
  getAvailableCommits(): CommitDataWithFileCount[] {
    const commitInfo = new Map<CommitHash, CommitDataWithFileCount>();
    for (const [filePath, metadata] of this.freshFiles.entries()) {
      const hash = metadata.commitHash;
      if (!hash) {
        continue;
      }

      if (commitInfo.has(hash)) {
        commitInfo.get(hash)!.fileCount++;
      } else {
        // Find which repo this file belongs to
        let repoName: string | undefined;
        for (const folder of this.workspaceFolders) {
          if (filePath.startsWith(folder.path)) {
            // For multi-repo workspaces, find the specific repo
            if (folder.gitRepos.length > 1) {
              const relativePath = filePath.substring(folder.path.length + 1);
              for (const repoRelPath of folder.gitRepos) {
                if (repoRelPath === "" || relativePath.startsWith(repoRelPath + "/")) {
                  repoName = repoRelPath === "" ? folder.name : repoRelPath.split("/").pop();
                  break;
                }
              }
            } else {
              repoName = folder.name;
            }
            break;
          }
        }

        commitInfo.set(hash, {
          message: asCommitMessage(metadata.commitMessage || "(no message)"),
          author: asCommitAuthor(metadata.author || "(unknown)"),
          date: metadata.date,
          fileCount: 1,
          hash: hash,
          repoName,
        });
      }
    }
    return Array.from(commitInfo.entries())
      .map(([_, info]) => ({ ...info }))
      .sort((a, b) => b.date.getTime() - a.date.getTime()); // Sort by date descending (newest first)
  }

  /** Get per-commit file-change stats for a given repo, from the historical cache. */
  getCommitStats(normalizedRepoPath: NormalizedRepoPath): Map<string, CommitStats> | undefined {
    return this.historicalCache.getCommitStats(normalizedRepoPath);
  }

  /** Get discovered repos as {name, normalizedPath} pairs for external consumers. */
  getRepoList(): { name: string; path: NormalizedRepoPath }[] {
    return this._resolvedRepos.map(r => ({ name: r.folder.name + (r.repoRelPath ? "/" + r.repoRelPath : ""), path: r.normalizedRepoPath }));
  }

  /** Get all visible file paths (excluding deleted files) for search operations */
  getVisibleFilePaths(): AbsolutePath[] {
    const files: AbsolutePath[] = [];
    for (const [filePath, metadata] of this.freshFiles.entries()) {
      if (this.isFileVisible(metadata)) {
        files.push(filePath);
      }
    }
    return files;
  }

  /** Get all visible files with their metadata (excluding deleted files) */
  getVisibleFilesWithMetadata(): Map<AbsolutePath, FileMetadata> {
    const files = new Map<AbsolutePath, FileMetadata>();
    for (const [filePath, metadata] of this.freshFiles.entries()) {
      if (this.isFileVisible(metadata)) {
        files.set(filePath, metadata);
      }
    }
    return files;
  }

  /** Check if we have any Git repositories */
  hasGitRepositories(): boolean {
    return this.workspaceFolders.some(folder => folder.gitRepos.length > 0);
  }

  /** Ensure data is loaded, triggering a load if necessary. Returns true if data is available. */
  async ensureDataLoaded(): Promise<boolean> {
    // Initialize workspace folders if not done
    if (this.workspaceFolders.length === 0) {
      this.initializeWorkspaceFolders();
    }

    // No workspace folders means no data possible
    if (this.workspaceFolders.length === 0) {
      return false;
    }

    // Load data if not already loaded
    // Note: Git repos are discovered during updateFreshFiles(), so we can't check
    // hasGitRepositories() before loading - it would always be false on first run
    if (!this.dataLoaded) {
      if (!this.refreshPromise) {
        log("ensureDataLoaded: Loading files from Git repositories...");
        this.refreshPromise = this.updateFreshFiles().finally(() => {
          this.refreshPromise = undefined;
        });
      }
      await this.refreshPromise;
    }

    // After loading, check if we found any repos
    return this.dataLoaded && this.hasGitRepositories();
  }

  /** Update sync warnings from git extension */
  setSyncWarnings(warnings: string[], silent = false): void {
    this.syncWarnings = warnings;
    if (!silent) {
      this.refreshTreeOnly();
    }
  }

  /** Set repository branch names from git extension */
  setRepoBranches(branches: Map<NormalizedRepoPath, BranchName>, silent = false): void {
    this.repoBranches = branches;
    if (!silent) {
      this.refreshTreeOnly();
    }
  }

  /** Current HEAD branch for the given normalized repo path, if known. */
  getRepoBranch(normalizedRepoPath: NormalizedRepoPath): BranchName | undefined {
    return this.repoBranches.get(normalizedRepoPath);
  }

  getTreeItem(element: FreshFilesTreeItem): vscode.TreeItem {
    return element;
  }

  getParent(element: FreshFilesTreeItem): FreshFilesTreeItem | undefined {
    if (!(element instanceof FreshFileItem)) {
      return undefined;
    }

    // Repo root nodes are root-level items — they have no parent in our tree.
    if (element.id?.startsWith("repo:")) {
      return undefined;
    }

    const folder = findWorkspaceFolderForPath(asAbsolutePath(element.resourceUri.fsPath), this.workspaceFolders);
    if (!folder) {
      return undefined;
    }

    // Compute the path relative to the workspace folder (normalized, forward slashes).
    const relativeToFolder = normalizePath(path.relative(folder.path, element.resourceUri.fsPath));

    // Find the most-specific repo that contains this item.
    const repoLocation = findRepoForFile(folder, relativeToFolder);
    if (!repoLocation) {
      return undefined;
    }

    // filePathInRepo is the path from the repo root to this item (normalized).
    const filePathInRepo = repoLocation.filePathInRepo;
    const lastSlash = filePathInRepo.lastIndexOf("/");

    // In flat list mode all files are direct children of the repo root — no directory nodes exist.
    if (this.groupingMode === "Flat List" || lastSlash === -1) {
      const repoFsPath = vscode.Uri.file(repoLocation.repoFullPath).fsPath;
      return this._repoItemCache.get(`repo:${repoFsPath}`);
    }

    // This item is nested inside a subdirectory — return the immediate parent directory.
    const parentPathInRepo = filePathInRepo.substring(0, lastSlash);
    const parentFullPath = path.join(repoLocation.repoFullPath, parentPathInRepo);
    const parentUri = vscode.Uri.file(parentFullPath);
    return FreshFileItem.forDirectory(
      parentUri,
      this.openChangesMode,
      this.countFilesInDirectory(parentUri.fsPath),
      false,
    );
  }

  async getChildren(element?: FreshFilesTreeItem): Promise<FreshFilesTreeItem[]> {
    if (element instanceof MessageTreeItem) {
      return [];
    }

    // Root level - check if we have any workspace folders
    if (!element) {
      if (this.workspaceFolders.length === 0) {
        return [new MessageTreeItem("No workspace folder open", "warning")];
      }

      // Start loading if not already in progress (fire-and-forget — we show
      // progress via reposDiscovered / reposLoading state instead of awaiting).
      if (!this.dataLoaded) {
        this.kickOffLoad();
      }

      // While repo discovery is still running, show a placeholder so VS Code
      // doesn't display an empty/blank tree.
      // Guard: if dataLoaded is already true the placeholder must not appear —
      // reposDiscovered might be stale-false after a mid-load refresh().
      if (!this.reposDiscovered && !this.dataLoaded) {
        return [new MessageTreeItem("Discovering repositories…", "loading~spin")];
      }

      const totalRepos = this.workspaceFolders.reduce((sum, folder) => sum + folder.gitRepos.length, 0);
      if (totalRepos === 0) {
        // Return empty array - viewsWelcome will show the initialize button
        return [];
      }

      // Check for errors - this would be shown in the view as the only message in case we can't recover at all
      if (this.errorToShowInTreeView) {
        return [new MessageTreeItem(this.errorToShowInTreeView, "error")];
      }

      // Collect results: sync warnings, then files or empty message
      const results: FreshFilesTreeItem[] = [];

      // Always show sync warnings at the top
      if (this.syncWarnings.length > 0) {
        results.push(...this.syncWarnings.map(w => new MessageTreeItem(w, "warning")));
      }

      // Show root folder node only if there is a single workspace folder and a single repo
      const contextValue = this.workspaceFolders.length === 1 && this.workspaceFolders[0].gitRepos.length === 1
        ? "workspaceFolder"
        : "repoFolder";
      const children = this.buildRepoView(results, contextValue);

      // Park uninitialized submodules under a single collapsed node at the bottom,
      // regardless of grouping mode, so the user knows they exist without scanning them.
      if (this._uninitializedSubmodules.length > 0) {
        children.push(new UninitializedSubmodulesGroupItem(this._uninitializedSubmodules.length));
      }
      return children;
    }

    if (element instanceof UninitializedSubmodulesGroupItem) {
      return this._uninitializedSubmodules.map(
        r => new UninitializedSubmoduleItem(r.repoRelPath, r.repoFullPath),
      );
    }

    if (isAuthorGroup(element)) {
      const authorName = element.label as string;
      return GroupingViewBuilder.buildAuthorFiles(
        authorName,
        this.freshFiles,
        (metadata) => this.filterManager.passesFilters(metadata),
        this.sortOrder,
        this.openChangesMode,
        true,
      );
    }

    if (isCommitHashGroup(element)) {
      const commitHash = element.label as string;
      return GroupingViewBuilder.buildCommitHashFiles(
        commitHash,
        this.freshFiles,
        (metadata) => this.filterManager.passesFilters(metadata),
        this.sortOrder,
        this.openChangesMode,
      );
    }

    if (isMoonPhaseGroup(element)) {
      const moonPhaseName = decodeURIComponent(element.resourceUri.path.replace("/", ""));
      return GroupingViewBuilder.buildMoonPhaseFiles(
        moonPhaseName as MoonPhase,
        this.freshFiles,
        (metadata) => this.filterManager.passesFilters(metadata),
        this.sortOrder,
        this.openChangesMode,
      );
    }

    if (isRetrogradeGroup(element)) {
      const retrogradeKey = decodeURIComponent(element.resourceUri.path.replace("/", ""));
      return GroupingViewBuilder.buildRetrogradeFiles(
        retrogradeKey,
        this.freshFiles,
        (metadata) => this.filterManager.passesFilters(metadata),
        this.sortOrder,
        this.openChangesMode,
      );
    }

    // Get children of a directory
    if (element instanceof FreshFileItem) {
      const normalizedPath = normalizePath(element.resourceUri.fsPath) as NormalizedRepoPath;
      // If this repo is still in the initial load, show a single spinner.
      if (this.reposLoading.has(normalizedPath)) {
        return [new MessageTreeItem("Loading…", "loading~spin")];
      }
      const children: FreshFilesTreeItem[] = (this.groupingMode === "Flat List" && element.id?.startsWith("repo:"))
        ? this.buildFlatList(element.resourceUri.fsPath)
        : this.buildTree(element.resourceUri.fsPath);
      // If pending is shown but historical is still running, prepend a history spinner
      if (this.reposLoadingHistorical.has(normalizedPath)) {
        children.unshift(new MessageTreeItem("Loading history…", "loading~spin"));
      }
      return children;
    }

    log("getChildren returning empty array (unknown element type)");
    return [];
  }

  private buildRepoView(results: FreshFilesTreeItem[], contextValue: string) {
    if (this.groupingMode !== "File Structure" && this.groupingMode !== "Flat List") {
      return GroupingViewBuilder.buildForGroupingMode(
        this.groupingMode,
        this.freshFiles,
        (metadata) => this.filterManager.passesFilters(metadata),
        this.sortOrder,
        this.openChangesMode,
        results,
      );
    }

    // Default: group by file structure
    for (const { folder, repoRelPath, repoFullPath, normalizedRepoPath } of this.resolvedRepos) {
      const repoName = repoRelPath || folder.name;
      const activeFolderScope = this.repoScope.getFolderScope(normalizedRepoPath);

      const filesInRepo = Array.from(this.freshFiles.keys()).filter(filePath => {
        const normalized = normalizePath(filePath);
        // File must be in this repo
        if (normalized !== normalizedRepoPath && !normalized.startsWith(normalizedRepoPath + "/")) {
          return false;
        }
        if (activeFolderScope && !normalized.startsWith(activeFolderScope + "/") && normalized !== activeFolderScope) {
          return false;
        }
        return true;
      });

      const fileCount = filesInRepo.length;

      const repoUri = vscode.Uri.file(repoFullPath);
      const branchName = this.repoBranches.get(normalizedRepoPath);
      const isLoading = this.reposLoading.has(normalizedRepoPath);
      const isLoadingHistorical = this.reposLoadingHistorical.has(normalizedRepoPath);
      const activePathspec = this.repoScope.getPathspec(normalizedRepoPath);

      // Compute a display-friendly folder scope label
      const folderScopeDisplay = activeFolderScope
        ? normalizePath(path.relative(repoFullPath, activeFolderScope))
        : undefined;

      // Respect auto-expand depth setting for repository roots. We must commit
      // to the expansion preference on the *first* render — VS Code's TreeView
      // locks in collapsibleState by item id, so a "Collapsed during load,
      // Expanded after" sequence leaves the repo permanently collapsed. During
      // loading we expand under the assumption that data is coming.
      const expectFiles = fileCount > 0 || isLoading || isLoadingHistorical;
      const shouldExpand = ConfigService.getAutoExpandDepth() > 0 && expectFiles;

      const repoItem = FreshFileItem.forRepository(
        repoUri,
        this.openChangesMode,
        fileCount,
        repoName,
        branchName,
        contextValue,
        shouldExpand,
        isLoading,
        activePathspec,
        folderScopeDisplay,
        isLoadingHistorical,
      );
      this._repoItemCache.set(repoItem.id!, repoItem);
      results.push(repoItem);
    }
    return results;
  }

  /** Total count of all git repositories across all workspace folders. */
  private get totalRepoCount(): number {
    return this.workspaceFolders.reduce((sum, f) => sum + f.gitRepos.length, 0);
  }

  /** All configured historical time windows (excludes the "pending" window). */
  private get historicalTimeWindows(): { type: "historical"; label: string; days: number }[] {
    return this.timeWindows.filter(
      (tw): tw is { type: "historical"; label: string; days: number } => tw.type === "historical",
    );
  }

  /** All repos across all workspace folders with pre-computed absolute and normalized paths. */
  private get resolvedRepos(): RepoInfo[] {
    return this._resolvedRepos;
  }

  /** Set of normalized absolute paths that are submodule repository roots. */
  private get submoduleRootPaths(): Set<AbsolutePath> {
    const set = new Set<AbsolutePath>();
    for (const repo of this._resolvedRepos) {
      if (repo.isSubmodule) {
        set.add(asAbsolutePath(normalizePath(repo.repoFullPath)));
      }
    }
    return set;
  }

  /**
   * Reveal and focus the repo node in the tree view that corresponds to
   * the given submodule file-system path.
   *
   * Uses the cached item instance from the last buildRepoView pass so that VS Code
   * receives the exact same object it already registered — constructing a new item
   * with the same id causes an "already registered" error.
   */
  async revealSubmoduleRepo(fsPath: string): Promise<void> {
    if (!this.treeView) { return; }
    const repoItem = this._repoItemCache.get(`repo:${fsPath}`);
    if (repoItem) {
      await this.treeView.reveal(repoItem, { select: true, focus: true });
    }
  }

  /**
   * Reveal the currently active editor's file in the tree.
   * @param focus Whether to move keyboard focus to the tree (true for manual command, false for auto-reveal).
   */
  async revealActiveFile(focus: boolean = false): Promise<void> {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (!uri) { return; }
    await this.revealFileByUri(uri, focus);
  }

  /**
   * Reveal a specific file URI in the Fresh Files tree.
   *
   * Skips when the view isn't visible *and* the caller isn't asking for
   * focus — auto-reveal shouldn't pop the view open uninvited. Explicit
   * user invocations (focus=true) always reveal.
   *
   * Returns true if the reveal succeeded; false when the file isn't
   * currently in the tree (filtered out, outside time window, deleted, etc.)
   */
  async revealFileByUri(uri: vscode.Uri, focus: boolean = false): Promise<boolean> {
    if (!this.treeView || !this.dataLoaded) { return false; }
    if (!focus && !this.treeView.visible) { return false; }
    if (uri.scheme !== "file") { return false; }

    const normalizedPath = asAbsolutePath(normalizePath(uri.fsPath));
    const metadata = this._freshFiles.get(normalizedPath);
    if (!metadata || metadata.isDeleted) { return false; }

    const item = FreshFileItem.forFile(
      uri,
      this.openChangesMode,
      false,
      metadata.commitHash,
      metadata.isPending ?? false,
      metadata.status,
      metadata.renameSource,
    );
    try {
      await this.treeView.reveal(item, { select: true, focus, expand: true });
      return true;
    } catch (e) {
      log(`revealFileByUri: could not reveal ${uri.fsPath}: ${e}`, "warn");
      return false;
    }
  }

  /** Returns true if a file passes the current visibility filters. */
  private isFileVisible(metadata: FileMetadata): boolean {
    return !metadata.isDeleted && this.filterManager.passesFilters(metadata);
  }

  private async updateFreshFiles(): Promise<void> {
    if (this.workspaceFolders.length === 0) {
      return;
    }

    const token = this.refreshGuard.capture();
    const assertNotCancelled = () => token.assertLive();

    try {
      // --- Phase 1: Discover repositories (skipped on soft refresh) ---
      await this.discoverRepositories(assertNotCancelled);

      const totalRepos = this.totalRepoCount;
      if (totalRepos === 0) {
        this.dataLoaded = true;
        this._onDidChangeTreeData.fire();
        return;
      }

      // --- Phase 2: Load files per repository (pending first, then historical) ---
      const errorToShow = await this.loadPendingAndHistoricalFiles(assertNotCancelled);

      this.errorToShowInTreeView = errorToShow;
      this.dataLoaded = true;

      log(
        `Loaded ${this._freshFiles.size} total fresh file(s) across ${totalRepos} Git repository(ies)`,
      );

      this._targetRepoPaths = undefined;
      this.heatmapProvider?.fireDidChange();
    } catch (e) {
      if (e instanceof RefreshCancelledError) {
        log("updateFreshFiles: cancelled (newer refresh started)");
        return;
      }
      throw e;
    }
  }

  private async discoverRepositories(assertNotCancelled: () => void): Promise<void> {
    // Skip if repos already discovered (soft refresh)
    if (this.reposDiscovered) {
      log(`Reloading files for ${this.totalRepoCount} known Git repository(ies) (skipping discovery)`);
      return;
    }

    // --- Phase 1: Discover repositories ---
    const discoveredRepos = await DataCollector.discoverAllRepos(this.workspaceFolders);
    assertNotCancelled();

    // Apply discovered repos only after confirming we're not cancelled,
    // so state is never mutated by a stale load.
    // Uninitialized submodules are display-only: they must stay out of _resolvedRepos
    // and folder.gitRepos so no scan/cache/branch-compare path ever runs git in them.
    this._uninitializedSubmodules = discoveredRepos.filter(r => r.isUninitialized);
    const scannableRepos = discoveredRepos.filter(r => !r.isUninitialized);

    // Back-fill folder.gitRepos for consumers that accept WorkspaceFolderInfo[] directly.
    for (const folder of this.workspaceFolders) {
      folder.gitRepos = [];
    }
    for (const repo of scannableRepos) {
      repo.folder.gitRepos.push(repo.repoRelPath);
    }
    this._resolvedRepos = scannableRepos;

    const uninitializedNote = this._uninitializedSubmodules.length > 0
      ? ` (+${this._uninitializedSubmodules.length} uninitialized submodule(s), display only)`
      : "";
    log(`Discovered ${this.totalRepoCount} Git repository(ies) across ${this.workspaceFolders.length} workspace folder(s)${uninitializedNote}`);

    // Mark all repos as loading and fire so the repo list appears immediately
    // with per-repo spinners before any git log commands have run.
    for (const { normalizedRepoPath } of this.resolvedRepos) {
      this.reposLoading.add(normalizedRepoPath);
    }

    this.reposDiscovered = true;
    this._onReposReady.fire();
    this._onDidChangeTreeData.fire(); // Show repo list with per-repo loading indicators
  }

  private async loadPendingAndHistoricalFiles(assertNotCancelled: () => void): Promise<string | undefined> {
    // When refreshing only specific repos, seed the accumulator maps with the surviving
    // data from non-target repos so their entries are preserved in the final result.
    const targetRepoPaths = this._targetRepoPaths;
    const newFiles = new Map<AbsolutePath, FileMetadata>(targetRepoPaths ? this._freshFiles : []);
    const newHistoricalFiles = new Map<AbsolutePath, FileMetadata>(targetRepoPaths ? this.historicalCache.historicalFiles : []);
    let errorToShow: string | undefined;
    const pendingOnly = isPendingChangesMode(this.currentTimeWindow);
    const histDays = this.currentTimeWindow.type === "historical" ? this.currentTimeWindow.days : 0;

    // Compute the maximum historical window — load this much from git in one pass and cache it.
    const historicalWindows = this.historicalTimeWindows;
    const maxDays = historicalWindows.length > 0 ? historicalWindows[historicalWindows.length - 1].days : histDays;

    // Build the threshold list: day values at which to fire incremental tree updates.
    const incrementalLoading = ConfigService.getincrementalTreeLoading();
    const thresholds = !pendingOnly
      ? (incrementalLoading
        ? historicalWindows.map(tw => tw.days).filter(d => d <= histDays)
        : [histDays])
      : [];

    for (const { folder, repoRelPath, normalizedRepoPath } of this.resolvedRepos) {
      assertNotCancelled();

      // Skip repos that are not in the targeted set (targeted refresh only).
      if (targetRepoPaths && !targetRepoPaths.includes(normalizedRepoPath)) {
        continue;
      }

      // Phase 2a: Load pending changes
      await this.loadPendingForRepo(folder, repoRelPath, normalizedRepoPath, newFiles, pendingOnly);
      assertNotCancelled();

      if (pendingOnly) {
        continue; // skip historical
      }

      // Phase 2b: Load historical changes
      const repoError = await this.loadHistoricalForRepo(
        folder,
        repoRelPath,
        normalizedRepoPath,
        maxDays,
        histDays,
        newFiles,
        newHistoricalFiles,
        thresholds,
      );
      assertNotCancelled();

      if (repoError) {
        if (repoError.isPathspecError) {
          const badPathspec = this.repoScope.getPathspec(normalizedRepoPath);
          this.repoScope.setPathspec(normalizedRepoPath, undefined);
          showWarning(`Invalid pathspec "${badPathspec}" was cleared. The tree will reload without it.`, true);
          this.refresh({ targetRepoPaths: [normalizedRepoPath] });
          throw new RefreshCancelledError();
        } else if (!errorToShow) {
          errorToShow = repoError.message;
        }
      }
    }

    return errorToShow;
  }

  private async loadPendingForRepo(
    folder: WorkspaceFolderInfo,
    repoRelPath: string,
    normalizedRepoPath: NormalizedRepoPath,
    newFiles: Map<AbsolutePath, FileMetadata>,
    pendingOnly: boolean,
  ): Promise<void> {
    // --- Phase 2: Pending changes (fast) ---
    try {
      await DataCollector.collectPendingForRepo(folder, repoRelPath, newFiles);

      // If historical mode, keep a secondary indicator so children show a history spinner.
      if (!pendingOnly) {
        this.reposLoadingHistorical.add(normalizedRepoPath);
      }
      this._setFreshFiles(new Map(newFiles));
    } finally {
      // Transition: pending loaded → remove spinner, expose pending files immediately.
      this.reposLoading.delete(normalizedRepoPath);
      this._onDidChangeTreeData.fire();
    }
  }

  private async loadHistoricalForRepo(
    folder: WorkspaceFolderInfo,
    repoRelPath: string,
    normalizedRepoPath: NormalizedRepoPath,
    maxDays: number,
    histDays: number,
    newFiles: Map<AbsolutePath, FileMetadata>,
    newHistoricalFiles: Map<AbsolutePath, FileMetadata>,
    thresholds: number[],
  ): Promise<{ message: string; isPathspecError: boolean } | undefined> {
    // --- Phase 3: Historical changes (potentially slow) ---
    // Capture epoch so incremental callbacks from stale loads are silently dropped.
    const token = this.refreshGuard.capture();
    const onThresholdCrossed = (days: number, partial: Map<AbsolutePath, FileMetadata>) => {
      if (!token.isLive()) { return; }

      // Update the historical cache incrementally so that a time-window switch
      // to any already-loaded window can be served instantly without re-running git.
      this.historicalCache.upgradeEntry(normalizedRepoPath, days, partial, this.repoScope.getPathspec(normalizedRepoPath));

      // If the user switched to a smaller window while this load was in-flight,
      // filter the display to that window so we don't over-expose data.
      const currentDays = this.currentTimeWindow.type === "historical" ? this.currentTimeWindow.days : undefined;
      let displayPartial = partial;
      if (currentDays !== undefined && currentDays < days && this.historicalCache.canServeWindow(currentDays, this.workspaceFolders, this.repoScope.pathspecs)) {
        log(`Threshold ≤${days}d crossed but current window is ${currentDays}d — filtering display`);
        const cacheEntry = this.historicalCache.getEntry(normalizedRepoPath);
        if (cacheEntry) {
          displayPartial = this.historicalCache.filterToWindow(cacheEntry.sortedByDate, currentDays);
        }
      }

      // Merge display partial with everything already loaded (pending + earlier repos).
      // Pending entries always win over historical entries for the same path.
      const merged = new Map<AbsolutePath, FileMetadata>(newFiles);
      for (const [absPath, metadata] of displayPartial) {
        if (!merged.has(absPath) || !merged.get(absPath)!.isPending) {
          merged.set(absPath, metadata);
        }
      }
      if (partial.size > 0) {
        this._setFreshFiles(merged);
        this._onDidChangeTreeData.fire();
        log(`Incremental update for ${normalizedRepoPath}: ${partial.size} file(s) at ≤${days}d`);
      } else log(`Incremental update skipped (no changes at ≤${days}d)`);

    };

    const commitStatsMap = new Map<string, CommitStats>();
    try {
      const { error: repoError, fullData } = await DataCollector.collectHistoricalForRepo(
        folder,
        repoRelPath,
        maxDays,
        newFiles,
        newHistoricalFiles,
        this.repoScope.getPathspec(normalizedRepoPath),
        thresholds,
        onThresholdCrossed,
        commitStatsMap,
      );

      if (!repoError && fullData.size > 0) {
        this.historicalCache.setEntry(normalizedRepoPath, fullData, maxDays, this.repoScope.getPathspec(normalizedRepoPath), commitStatsMap);
        log(`Cached ${fullData.size} file(s) for ${normalizedRepoPath}`);
      }

      // Historical git log always loads up to maxDays, but we must only display
      // the currently selected histDays window. Filter before updating the live view
      // so we don't over-expose data from the wider load.
      if (histDays < maxDays) {
        const cutoff = new Date(Date.now() - histDays * 24 * 60 * 60 * 1000);
        this._setFreshFiles(new Map([...newFiles].filter(([, m]) => m.isPending || m.date >= cutoff)));
        this.historicalCache.historicalFiles = new Map([...newHistoricalFiles].filter(([, m]) => m.date >= cutoff));
      } else {
        this._setFreshFiles(new Map(newFiles));
        this.historicalCache.historicalFiles = new Map(newHistoricalFiles);
      }

      return repoError;
    } finally {
      this.reposLoadingHistorical.delete(normalizedRepoPath);
      this._onDidChangeTreeData.fire();
    }
  }

  /**
   * Replace freshFiles, rebuild the path index, and invalidate the stats cache.
   * All internal assignments to freshFiles must go through here.
   */
  private _setFreshFiles(map: Map<AbsolutePath, FileMetadata>): void {
    this._freshFiles = map;
    this.fileIndex.rebuild(map);
  }

  getCacheStats(): CacheRepoStats[] {
    return this.historicalCache.getStats(this.workspaceFolders);
  }

  private _dirStats() {
    return this.fileIndex.ensureDirStats(
      this._freshFiles,
      (m) => this.filterManager.passesFilters(m),
      (p) => this.passesRepoScope(p),
      ConfigService.getDescriptionFormat().showLineChanges,
    );
  }

  private countFilesInDirectory(dirPath: string): number {
    return this._dirStats().get(asAbsolutePath(dirPath))?.count ?? 0;
  }

  getMostRecentDateInDirectory(dirPath: string): Date | undefined {
    return this._dirStats().get(asAbsolutePath(dirPath))?.mostRecent;
  }

  private buildTree(parentPath: string): (FreshFileItem | SubmoduleEntryItem)[] {
    const normalizedParent = asAbsolutePath(parentPath);

    const directChildren = this.fileIndex.getDirectChildren(normalizedParent);
    if (!directChildren || directChildren.size === 0) { return []; }

    // Build the dir stats cache once (shared across all buildTree calls this render pass).
    const descriptionFormat = ConfigService.getDescriptionFormat();
    const dirStats = this.fileIndex.ensureDirStats(
      this._freshFiles,
      (m) => this.filterManager.passesFilters(m),
      (p) => this.passesRepoScope(p),
      descriptionFormat.showLineChanges,
    );
    const autoExpandDepth = ConfigService.getAutoExpandDepth();

    const items: (FreshFileItem | SubmoduleEntryItem)[] = [];

    for (const childPath of directChildren) {
      const isFile = this._freshFiles.has(childPath);
      const name = childPath.substring(normalizedParent.length + 1);
      const fullPath = path.join(parentPath, name);
      const uri = vscode.Uri.file(fullPath);

      if (isFile) {
        const metadata = this._freshFiles.get(childPath)!;
        if (!this.filterManager.passesFilters(metadata)) { continue; }
        if (!this.passesRepoScope(childPath)) { continue; }

        // Submodule roots are shown as a custom entry (no file URI) to work around weirdness with duplicates in the tree
        if (this.submoduleRootPaths.has(childPath)) {
          items.push(new SubmoduleEntryItem(fullPath, parentPath));
          continue;
        }

        const item = FreshFileItem.forFile(
          uri, this.openChangesMode,
          metadata.isDeleted ?? false,
          metadata.commitHash,
          metadata.isPending ?? false,
          metadata.status,
          metadata.renameSource,
        );
        item.description = formatFileDescription(metadata, descriptionFormat);
        item.tooltip = formatFileTooltip(metadata, descriptionFormat);
        items.push(item);
      } else {
        // Directory — stats already respect filters and scopes
        const stats = dirStats.get(childPath);
        if (!stats || stats.count === 0) { continue; }

        const relativeDepth = getRelativeDepth(fullPath, this.workspaceFolders);
        const shouldExpand = relativeDepth < autoExpandDepth;
        const item = FreshFileItem.forDirectory(uri, this.openChangesMode, stats.count, shouldExpand);

        if (stats.mostRecent) {
          const lineChanges = descriptionFormat.showLineChanges && (stats.linesAdded > 0 || stats.linesDeleted > 0)
            ? { added: stats.linesAdded, deleted: stats.linesDeleted }
            : undefined;
          item.description = formatGroupDescription(stats.count, lineChanges?.added, lineChanges?.deleted);
          item.tooltip = formatDirectoryTooltip(stats.count, stats.mostRecent, lineChanges?.added, lineChanges?.deleted);
        }
        items.push(item);
      }
    }

    FreshFileItemSorter.sort(
      items,
      this.sortOrder,
      (item) => {
        if (item instanceof SubmoduleEntryItem) {
          return this._freshFiles.get(asAbsolutePath(item.submoduleFsPath))?.date;
        }
        return item.isDirectory
          ? dirStats.get(asAbsolutePath(item.resourceUri.fsPath))?.mostRecent
          : this._freshFiles.get(asAbsolutePath(item.resourceUri.fsPath))?.date;
      },
      (item) => {
        if (item instanceof SubmoduleEntryItem) {
          return this._freshFiles.get(asAbsolutePath(item.submoduleFsPath))?.author || "";
        }
        return item.isDirectory
          ? ""
          : (this._freshFiles.get(asAbsolutePath(item.resourceUri.fsPath))?.author || "");
      },
    );

    return items;
  }

  private buildFlatList(repoFsPath: string): FreshFileItem[] {
    const normalizedRepoPath = asAbsolutePath(normalizePath(repoFsPath));
    const descriptionFormat = ConfigService.getDescriptionFormat();
    const items: FreshFileItem[] = [];

    for (const [filePath, metadata] of this._freshFiles) {
      if (!filePath.startsWith(normalizedRepoPath + "/") && filePath !== normalizedRepoPath) {
        continue;
      }
      if (!this.filterManager.passesFilters(metadata)) { continue; }
      if (!this.passesRepoScope(filePath)) { continue; }

      const uri = vscode.Uri.file(filePath);
      const item = FreshFileItem.forFile(
        uri,
        this.openChangesMode,
        metadata.isDeleted ?? false,
        metadata.commitHash,
        metadata.isPending ?? false,
        metadata.status,
        metadata.renameSource,
      );
      if (ConfigService.getFlatListLabelStyle() === "filename") {
        item.label = path.basename(filePath);
        const dirRel = normalizePath(path.relative(repoFsPath, path.dirname(filePath)));
        const fileDesc = formatFileDescription(metadata, descriptionFormat);
        item.description = dirRel ? `${dirRel}  ${fileDesc}` : fileDesc;
      } else {
        // "path" (default): repo-relative path as label.
        item.label = normalizePath(path.relative(repoFsPath, filePath));
        item.description = formatFileDescription(metadata, descriptionFormat);
      }
      item.tooltip = formatFileTooltip(metadata, descriptionFormat);
      items.push(item);
    }

    FreshFileItemSorter.sort(
      items,
      this.sortOrder,
      (item) => item.resourceUri ? this._freshFiles.get(asAbsolutePath(item.resourceUri.fsPath))?.date : undefined,
      (item) => item.resourceUri ? (this._freshFiles.get(asAbsolutePath(item.resourceUri.fsPath))?.author || "") : "",
    );

    return items;
  }
}

/** Returns true if `normalizedFilePath` belongs to any of the given normalized repo paths. */
function fileInTargetRepo(normalizedFilePath: string, targetRepoPaths: string[]): boolean {
  return targetRepoPaths.some(rp => normalizedFilePath.startsWith(rp + "/") || normalizedFilePath === rp);
}

/**
 * Returns a copy of `map` with all entries whose path belongs to any of
 * `targetRepoPaths` removed. Used to strip a repo's stale data before reload.
 */
function fileMapExcludingRepos<V>(
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
function buildTargetWorkspaceFolders(
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
