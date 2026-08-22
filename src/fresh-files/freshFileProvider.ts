import * as vscode from "vscode";

import { ConfigService } from "../config/configService";
import { ConfigKeys } from "../config/configKeyConstants";
import { HistoricalFileCache, type CacheRepoStats } from "./historicalFileCache";
import { FileIndex } from "./fileIndex";
import { RefreshCancelledError } from "./refreshEpochGuard";
import { RepoScopeStore } from "./repoScopeStore";
import { aggregateAuthors, aggregateCommits } from "./freshFilesAggregator";
import { fileMapExcludingRepos, buildTargetWorkspaceFolders, computeHistoricalLoadPlan, scopeFilesByRepo, mergePendingFiles } from "./freshFileMapUtils";
import { findParentItem, revealFileInTree } from "./treeNavigation";
export type { CacheRepoStats };
import {
  WorkspaceFolderInfo,
  FileMetadata,
  AuthorData,
  BranchName,
  CommitStats,
  CommitDataWithFileCount,
  SortOrder,
} from "../types";
import { buildTimeWindows, isPendingChangesMode, TimeWindow } from "./timeWindowUtils";
import { AbsolutePath, asAbsolutePath } from "../pathTypes";
import { log, showWarning } from "../extension/logger";
import { FreshFileItem, MessageTreeItem as MessageTreeItem, FreshFilesTreeItem, UninitializedSubmodulesGroupItem, UninitializedSubmoduleItem, isAuthorGroup, isCommitHashGroup, isPendingGroup, isMoonPhaseGroup } from "./freshFileTreeItems";
import { normalizePath } from "../utils";
import { GroupingMode, DEFAULT_GROUPING_MODE } from "./groupingMode";
import { type MoonPhase } from "./moonPhase";
import { FilterManager } from "./freshFileFilterManager";
import { GroupingViewBuilder } from "./groupingViewBuilder";
import { DataCollector, RepoInfo } from "./dataCollector";
import { NormalizedRepoPath } from "../pathTypes";
import { ContextManager } from "../extension/contextManager";
import { WorkspaceStateManager } from "../extension/workspaceStateManager";
import { FilesExcludeFilter } from "./filesExcludeFilter";
import { buildTree, buildFlatList, buildRepoRootItems, type TreeBuildContext, type RepoViewContext } from "./treeStructureBuilder";
import { resolveConfigRefreshAction } from "./configRefreshAction";
import { RepoHealthNotifier } from "./repoHealthNotifier";
import { RepoDiscovery } from "./repoDiscovery";
import { LoadOrchestrator } from "./loadOrchestrator";
import { Commands } from "../commands/commandConstants";

export class FreshFileProvider implements vscode.TreeDataProvider<FreshFilesTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<FreshFilesTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /**
   * Fires every time repo discovery transitions to "done" — initial activation
   * and after any subsequent `hardRefresh()`. Lets dependent features (e.g. the
   * blame heatmap auto-apply) wait until `findRepoForAbsolutePath` will actually
   * resolve before they try to attach to the active editor.
   */
  get onReposReady(): vscode.Event<void> { return this.discovery.onReposReady; }
  get areReposReady(): boolean { return this.discovery.reposDiscovered; }
  private get reposDiscovered(): boolean { return this.discovery.reposDiscovered; }

  /**
   * Snapshot of where loading currently sits — drives the fresh-files status
   * bar entry. Listeners react via `onDidChangeTreeData`.
   */
  getLoadingProgress(): { state: "dormant" | "discovering" | "loading" | "idle"; totalRepos: number; loadedRepos: number } {
    return this.load.getLoadingProgress();
  }

  // Map of absolute file path to file metadata
  private _freshFiles: Map<AbsolutePath, FileMetadata> = new Map();
  get freshFiles(): Map<AbsolutePath, FileMetadata> { return this._freshFiles; }

  /**
   * `_freshFiles` with files.exclude applied by each file's *owning* folder —
   * used only by the flat lenses (group-by-author/commit, search) that have no
   * folder-node context. The File Structure / Flat List trees instead evaluate
   * files.exclude per node at render time. Same reference as `_freshFiles` when
   * the feature is off or nothing is excluded. Recomputed in `_setFreshFiles`.
   */
  private _displayFreshFiles: Map<AbsolutePath, FileMetadata> = new Map();
  /** Applies each folder's `files.exclude` to produce `_displayFreshFiles`. */
  private filesExcludeFilter = new FilesExcludeFilter(
    () => ConfigService.getRespectFilesExclude(),
    (folderPath) => ConfigService.getFilesExcludeExpression(vscode.Uri.file(folderPath)),
  );

  // Path index + per-render dir-stats cache.
  private fileIndex = new FileIndex();
  currentTimeWindow: TimeWindow;
  timeWindows: TimeWindow[];
  workspaceFolders: WorkspaceFolderInfo[] = [];
  private errorToShowInTreeView: string | undefined;
  private readonly repoHealth = new RepoHealthNotifier();
  // Repo discovery: workspace walk, results, in-flight dedup, onReposReady.
  private readonly discovery = new RepoDiscovery({
    getWorkspaceFolders: () => this.workspaceFolders,
    onBrokenWorktrees: (paths) => void this.repoHealth.notifyBrokenWorktrees(paths),
  });
  // Load lifecycle: refresh hierarchy, cancellation epoch, in-flight dedup,
  // manual-scan dormancy, target scoping, per-repo loading sets.
  private readonly load = new LoadOrchestrator(this.discovery, {
    hasWorkspaceFolders: () => this.workspaceFolders.length > 0,
    resetData: (opts) => this.resetDataForRefresh(opts),
    loadFiles: (assertNotCancelled) => this.loadPendingAndHistoricalFiles(assertNotCancelled),
    updatePending: (targetRepoPaths) => this.updatePendingFiles(targetRepoPaths),
    onLoadCompleted: (error) => {
      this.errorToShowInTreeView = error;
      log(`Loaded ${this._freshFiles.size} total fresh file(s) across ${this.discovery.resolvedRepos.length} Git repository(ies)`);
      this.heatmapProvider?.fireDidChange();
    },
    ensureDiscovered: () => this.ensureReposDiscovered(),
    fireTree: () => this._onDidChangeTreeData.fire(),
  });
  private get dataLoaded(): boolean { return this.load.dataLoaded; }
  get isDataLoaded(): boolean { return this.load.dataLoaded; }

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

  readonly filterManager = new FilterManager();

  // Incremented every time refreshPending() runs, so external listeners can detect
  // that a pending refresh already happened and skip scheduling a duplicate.
  get pendingRefreshVersion(): number { return this.load.pendingRefreshVersion; }

  // Per-repo scoping state: git pathspec (restricts a repo's `git log`) and
  // folder scope (display-only narrowing). Owns its own persistence.
  private readonly repoScope = new RepoScopeStore();

  // Cache of the most-recently returned repo root FreshFileItem instances, keyed by id.
  // Populated in buildRepoView so revealSubmoduleRepo can pass the exact same object
  // instances that VS Code already registered (reveal() rejects freshly constructed duplicates).
  private _repoItemCache: Map<string, FreshFileItem> = new Map();

  readonly historicalCache = new HistoricalFileCache();

  constructor() {
    this.initializeWorkspaceFolders();
    this.timeWindows = this.loadTimeWindows();
    this.currentTimeWindow = this.timeWindows[0]; // Will be overridden by persisted value
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
    return buildTimeWindows(ConfigService.getTimeWindows());
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
    // Toggling files.exclude support changes the display view, not the data —
    // rebuild the exclude-filtered map + index from cache before the treeOnly
    // refresh below re-renders.
    if (e.affectsConfiguration(ConfigKeys.RESPECT_FILES_EXCLUDE)) {
      this.filesExcludeFilter.invalidate();
      this._setFreshFiles(this._freshFiles);
    }

    // Changing the loading mode resets the session's armed state, so switching
    // back to manual takes effect immediately instead of waiting for a window reload.
    if (e.affectsConfiguration(ConfigKeys.FRESH_FILE_LOADING)) {
      this.load.resetArm();
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

    const action = resolveConfigRefreshAction(section => e.affectsConfiguration(section));

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
        const _exhaustive: never = action;
        throw new Error(`Unhandled RefreshAction: ${_exhaustive}`);
      }
    }
  }

  /** Soft refresh: reload files from known repos (see LoadOrchestrator.refresh). */
  refresh(options?: { preserveHistoricalCache?: boolean; targetRepoPaths?: NormalizedRepoPath[] }): void {
    this.load.refresh(options);
  }

  /** Hard refresh: re-discover repositories then reload all files. */
  hardRefresh(): void {
    this.load.hardRefresh();
  }

  /** Evicts file data for a refresh — the data half of LoadOrchestrator.refresh/hardRefresh. */
  private resetDataForRefresh(opts: { hard: boolean; targetRepoPaths?: NormalizedRepoPath[]; preserveHistoricalCache?: boolean }): void {
    if (opts.hard) {
      this._repoItemCache.clear();
      this._setFreshFiles(new Map());
      this.historicalCache.clear();
      return;
    }
    if (opts.targetRepoPaths) {
      // Targeted refresh: remove only affected repos' files, keep other repos intact.
      this._setFreshFiles(fileMapExcludingRepos(this._freshFiles, opts.targetRepoPaths));
      if (opts.preserveHistoricalCache) {
        this.historicalCache.historicalFiles = fileMapExcludingRepos(this.historicalCache.historicalFiles, opts.targetRepoPaths);
      } else {
        this.historicalCache.clearForRepos(opts.targetRepoPaths);
      }
    } else {
      this._setFreshFiles(new Map());
      if (opts.preserveHistoricalCache) {
        this.historicalCache.historicalFiles = new Map();
      } else {
        this.historicalCache.clear();
      }
    }
  }

  /** Refresh the tree display without reloading data from git */
  refreshTreeOnly(): void {
    this.fileIndex.invalidateStats(); // filters/scopes may have changed
    this._onDidChangeTreeData.fire();
  }

  /** Refresh only the pending layer, leaving historical data cached. */
  async refreshPending(targetRepoPaths?: NormalizedRepoPath[]): Promise<void> {
    return this.load.refreshPending(targetRepoPaths);
  }

  private async updatePendingFiles(targetRepoPaths?: NormalizedRepoPath[]): Promise<void> {
    if (this.workspaceFolders.length === 0) {
      return;
    }
    // Targeted update: only query the repos that changed.
    const folders = targetRepoPaths
      ? buildTargetWorkspaceFolders(this.workspaceFolders, targetRepoPaths)
      : this.workspaceFolders;
    const { files: pendingFiles, removedPaths } = await DataCollector.collectPendingFiles(folders);
    this._setFreshFiles(mergePendingFiles({
      historicalFiles: this.historicalCache.historicalFiles,
      currentFiles: this._freshFiles,
      pendingFiles,
      removedPaths,
      targetRepoPaths,
    }));
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
        this.load.cancelInFlight(); // cancel any in-flight load
        this.load.markLoadedFromCache();
        this._setFreshFiles(this.historicalCache
          .applyWindowToFiles(timeWindow.days, this.workspaceFolders, this.freshFiles));
        this.refreshTreeOnly();
        return;
      }
      // An in-flight load always targets the maximum configured interval.
      // If there's a load in progress and it covers the new window, don't cancel it —
      // the incremental cache updates will apply the new window as each threshold is crossed.
      const configuredMaxDays = Math.max(0, ...this.historicalTimeWindows.map(tw => tw.days));
      if (this.load.hasInFlightLoad && configuredMaxDays >= timeWindow.days) {
        log(`Time window set to ${timeWindow.label} — will be covered by in-flight load`);
        this.refreshTreeOnly();
        return;
      }
    } else if (timeWindow.type === "pending" && this.dataLoaded) {
      // Pending files are already present in freshFiles — no git operations needed.
      log(`Serving pending window from existing data`);
      this.load.cancelInFlight(); // cancel any in-flight load
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
        "This view checks the most recent commit per file. " +
        "If a file was modified multiple times, " +
        "only the latest change is shown.";
    }
  }

  /** Get list of unique authors from current files */
  getAvailableAuthors(): AuthorData[] {
    return aggregateAuthors(this._displayFreshFiles);
  }

  /** Get list of unique commits from current files */
  getAvailableCommits(): CommitDataWithFileCount[] {
    return aggregateCommits(this._displayFreshFiles, this.workspaceFolders);
  }

  /** Get per-commit file-change stats for a given repo, from the historical cache. */
  getCommitStats(normalizedRepoPath: NormalizedRepoPath): Map<string, CommitStats> | undefined {
    return this.historicalCache.getCommitStats(normalizedRepoPath);
  }

  /** Get discovered repos as {name, normalizedPath} pairs for external consumers. */
  getRepoList(): { name: string; path: NormalizedRepoPath }[] {
    return this.discovery.resolvedRepos.map(r => ({ name: r.folder.name + (r.repoRelPath ? "/" + r.repoRelPath : ""), path: r.normalizedRepoPath }));
  }

  /** Get all visible file paths (excluding deleted files) for search operations */
  getVisibleFilePaths(): AbsolutePath[] {
    const files: AbsolutePath[] = [];
    for (const [filePath, metadata] of this._displayFreshFiles.entries()) {
      if (this.isFileVisible(metadata)) {
        files.push(filePath);
      }
    }
    return files;
  }

  /** Get all visible files with their metadata (excluding deleted files) */
  getVisibleFilesWithMetadata(): Map<AbsolutePath, FileMetadata> {
    const files = new Map<AbsolutePath, FileMetadata>();
    for (const [filePath, metadata] of this._displayFreshFiles.entries()) {
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

  /**
   * True if `normalizedRepoPath` is already in FFE's discovered set (a scannable repo or a
   * known uninitialized submodule). The git-extension listener uses this to tell a genuinely
   * new repository (e.g. a freshly created worktree) apart from one we already track.
   */
  knowsRepoPath(normalizedRepoPath: NormalizedRepoPath): boolean {
    return this.discovery.resolvedRepos.some(r => r.normalizedRepoPath === normalizedRepoPath)
      || this.discovery.uninitializedSubmodules.some(r => r.normalizedRepoPath === normalizedRepoPath);
  }

  /**
   * True if `normalizedAbsPath` lies within one of the workspace folders FFE scans. A repository
   * VS Code opens outside the workspace can never be picked up by discovery, so the listener
   * should ignore it rather than trigger a pointless hard refresh.
   */
  isWithinWorkspace(normalizedAbsPath: string): boolean {
    return this.workspaceFolders.some(folder => {
      const root = normalizePath(folder.path);
      return normalizedAbsPath === root || normalizedAbsPath.startsWith(root + "/");
    });
  }

  /** Ensure data is loaded, triggering (and arming) a load if necessary. Returns true if data is available. */
  async ensureDataLoaded(): Promise<boolean> {
    // Initialize workspace folders if not done
    if (this.workspaceFolders.length === 0) {
      this.initializeWorkspaceFolders();
    }

    // No workspace folders means no data possible
    if (this.workspaceFolders.length === 0) {
      return false;
    }

    // Note: Git repos are discovered during the load, so we can't check
    // hasGitRepositories() before loading - it would always be false on first run
    await this.load.ensureLoaded();
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
    return findParentItem(element, {
      workspaceFolders: this.workspaceFolders,
      groupingMode: this.groupingMode,
      openChangesMode: this.openChangesMode,
      repoItemCache: this._repoItemCache,
      countFilesInDirectory: (p) => this.countFilesInDirectory(p),
    });
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
        this.load.kickOffLoad();
      }

      // While repo discovery is still running, show a placeholder so VS Code
      // doesn't display an empty/blank tree.
      // Guard: if dataLoaded is already true the placeholder must not appear —
      // reposDiscovered might be stale-false after a mid-load refresh().
      if (!this.reposDiscovered && !this.dataLoaded) {
        return [new MessageTreeItem("Discovering repositories…", "loading~spin")];
      }

      // Manual scan, not yet armed: no history has been read, so the repo nodes
      // below would render as a list of empty repos. Offer the scan instead.
      if (this.isScanDormant) {
        return [new MessageTreeItem(
          "Scan on startup is disabled — click to load",
          "debug-start",
          { command: Commands.REFRESH, title: "Load fresh files" },
        )];
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
      const repoItems = buildRepoRootItems(contextValue, this.repoViewContext);
      // Cache the exact instances VS Code registers — reveal() rejects fresh duplicates.
      for (const repoItem of repoItems) { this._repoItemCache.set(repoItem.id!, repoItem); }
      results.push(...repoItems);
      const children = results;

      // Park uninitialized submodules under a single collapsed node at the bottom,
      // regardless of grouping mode, so the user knows they exist without scanning them.
      if (this.discovery.uninitializedSubmodules.length > 0) {
        children.push(new UninitializedSubmodulesGroupItem(this.discovery.uninitializedSubmodules.length));
      }
      return children;
    }

    if (element instanceof UninitializedSubmodulesGroupItem) {
      return this.discovery.uninitializedSubmodules.map(
        r => new UninitializedSubmoduleItem(r.repoRelPath, r.repoFullPath),
      );
    }

    if (isAuthorGroup(element)) {
      const authorName = element.label as string;
      return GroupingViewBuilder.buildAuthorFiles(
        authorName,
        this.freshFilesForRepoScope(element.groupRepoScope),
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
        this.freshFilesForRepoScope(element.groupRepoScope),
        (metadata) => this.filterManager.passesFilters(metadata),
        this.sortOrder,
        this.openChangesMode,
      );
    }

    if (isPendingGroup(element)) {
      return GroupingViewBuilder.buildPendingFiles(
        this.freshFilesForRepoScope(element.groupRepoScope),
        (metadata) => this.filterManager.passesFilters(metadata),
        this.sortOrder,
        this.openChangesMode,
      );
    }

    if (isMoonPhaseGroup(element)) {
      const moonPhaseName = decodeURIComponent(element.resourceUri.path.replace("/", ""));
      return GroupingViewBuilder.buildMoonPhaseFiles(
        moonPhaseName as MoonPhase,
        this.freshFilesForRepoScope(element.groupRepoScope),
        (metadata) => this.filterManager.passesFilters(metadata),
        this.sortOrder,
        this.openChangesMode,
      );
    }

    // Get children of a directory
    if (element instanceof FreshFileItem) {
      const normalizedPath = normalizePath(element.resourceUri.fsPath) as NormalizedRepoPath;
      // If this repo is still in the initial load, show a single spinner.
      if (this.load.reposLoading.has(normalizedPath)) {
        return [new MessageTreeItem("Loading…", "loading~spin")];
      }
      const isRepoNode = element.id?.startsWith("repo:") ?? false;
      const isGroupingMode = this.groupingMode !== "File Structure" && this.groupingMode !== "Flat List";
      const children: FreshFilesTreeItem[] =
        isRepoNode && isGroupingMode
          ? this.buildGroupedChildrenForRepo(element.resourceUri.fsPath)
          : (this.groupingMode === "Flat List" && isRepoNode)
            ? buildFlatList(element.resourceUri.fsPath, this.treeBuildContext)
            : buildTree(element.resourceUri.fsPath, this.treeBuildContext);
      // If pending is shown but historical is still running, prepend a history spinner
      if (this.load.reposLoadingHistorical.has(normalizedPath)) {
        children.unshift(new MessageTreeItem("Loading history…", "loading~spin"));
      }
      return children;
    }

    log("getChildren returning empty array (unknown element type)");
    return [];
  }

  /** See {@link scopeFilesByRepo} — narrows `_displayFreshFiles` to one repo. */
  private freshFilesForRepoScope(repoScope?: string): Map<AbsolutePath, FileMetadata> {
    return scopeFilesByRepo(this._displayFreshFiles, repoScope);
  }

  /** Build a repo node's children in a grouping mode: author/commit/pending groups scoped to that repo. */
  private buildGroupedChildrenForRepo(repoFsPath: string): FreshFilesTreeItem[] {
    const repoScope = normalizePath(repoFsPath);
    return GroupingViewBuilder.buildForGroupingMode(
      this.groupingMode as Exclude<GroupingMode, "File Structure" | "Flat List">,
      this.freshFilesForRepoScope(repoScope),
      (metadata) => this.filterManager.passesFilters(metadata),
      this.sortOrder,
      this.openChangesMode,
      [],
      repoScope,
    );
  }

  /** Bundle the state the repo-root view builder needs (see treeStructureBuilder.ts). */
  private get repoViewContext(): RepoViewContext {
    return {
      resolvedRepos: this.resolvedRepos,
      freshFiles: this._freshFiles,
      filesExcludeFilter: this.filesExcludeFilter,
      getFolderScope: (repo) => this.repoScope.getFolderScope(repo),
      getPathspec: (repo) => this.repoScope.getPathspec(repo),
      repoBranches: this.repoBranches,
      reposLoading: this.load.reposLoading,
      reposLoadingHistorical: this.load.reposLoadingHistorical,
      openChangesMode: this.openChangesMode,
    };
  }


  /** All configured historical time windows (excludes the "pending" window). */
  private get historicalTimeWindows(): { type: "historical"; label: string; days: number }[] {
    return this.timeWindows.filter(
      (tw): tw is { type: "historical"; label: string; days: number } => tw.type === "historical",
    );
  }

  /** All repos across all workspace folders with pre-computed absolute and normalized paths. */
  private get resolvedRepos(): RepoInfo[] {
    return this.discovery.resolvedRepos;
  }

  /** Set of normalized absolute paths that are submodule repository roots. */
  private get submoduleRootPaths(): Set<AbsolutePath> {
    const set = new Set<AbsolutePath>();
    for (const repo of this.discovery.resolvedRepos) {
      if (repo.isSubmodule) {
        set.add(asAbsolutePath(normalizePath(repo.repoFullPath)));
      }
    }
    return set;
  }

  /** Bundle the state the structural tree builders need (see treeStructureBuilder.ts). */
  private get treeBuildContext(): TreeBuildContext {
    return {
      freshFiles: this._freshFiles,
      fileIndex: this.fileIndex,
      filterManager: this.filterManager,
      filesExcludeFilter: this.filesExcludeFilter,
      workspaceFolders: this.workspaceFolders,
      submoduleRootPaths: this.submoduleRootPaths,
      passesRepoScope: (p) => this.passesRepoScope(p),
      sortOrder: this.sortOrder,
      openChangesMode: this.openChangesMode,
    };
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

  /** Reveal a file in the tree — see `revealFileInTree` for the visibility rules. */
  async revealFileByUri(uri: vscode.Uri, focus: boolean = false): Promise<boolean> {
    return revealFileInTree(uri, focus, {
      treeView: this.treeView,
      dataLoaded: this.dataLoaded,
      freshFiles: this._freshFiles,
      openChangesMode: this.openChangesMode,
    });
  }

  /** Returns true if a file passes the current visibility filters. */
  private isFileVisible(metadata: FileMetadata): boolean {
    return !metadata.isDeleted && this.filterManager.passesFilters(metadata);
  }

  /** True while manual scan is on and no explicit Refresh has armed the scan yet. */
  get isScanDormant(): boolean {
    return this.load.isScanDormant;
  }

  /** Arm the scan for the rest of the session (see LoadOrchestrator.armScan). */
  armScan(): void {
    this.load.armScan();
  }

  /**
   * Discover repositories without loading any file history. Lets discovery-only
   * consumers (branch compare, blame heatmap) resolve repos even when the
   * fresh-files scan hasn't run. No-op once repos are discovered.
   *
   * Resolves quietly if a concurrent refresh cancels the discovery — that refresh
   * runs its own discovery, so the caller's `onReposReady` still arrives.
   */
  async ensureReposDiscovered(): Promise<void> {
    if (this.reposDiscovered) { return; }
    if (this.workspaceFolders.length === 0) {
      this.initializeWorkspaceFolders();
      if (this.workspaceFolders.length === 0) { return; }
    }

    const token = this.load.captureEpoch();
    try {
      await this.discovery.discoverRepositories(() => token.assertLive());
    } catch (e) {
      if (e instanceof RefreshCancelledError) {
        log("ensureReposDiscovered: cancelled (refresh started)");
        return;
      }
      throw e;
    }
    this._onDidChangeTreeData.fire(); // repo nodes can render now
  }

  private async loadPendingAndHistoricalFiles(assertNotCancelled: () => void): Promise<string | undefined> {
    // When refreshing only specific repos, seed the accumulator maps with the surviving
    // data from non-target repos so their entries are preserved in the final result.
    const targetRepoPaths = this.load.targetRepoPaths;
    const newFiles = new Map<AbsolutePath, FileMetadata>(targetRepoPaths ? this._freshFiles : []);
    const newHistoricalFiles = new Map<AbsolutePath, FileMetadata>(targetRepoPaths ? this.historicalCache.historicalFiles : []);
    let errorToShow: string | undefined;
    const pendingOnly = isPendingChangesMode(this.currentTimeWindow);
    const histDays = this.currentTimeWindow.type === "historical" ? this.currentTimeWindow.days : 0;

    const { maxDays, thresholds } = computeHistoricalLoadPlan(
      this.historicalTimeWindows,
      histDays,
      pendingOnly,
      ConfigService.getincrementalTreeLoading(),
    );

    for (const { folder, repoRelPath, normalizedRepoPath } of this.resolvedRepos) {
      assertNotCancelled();

      // Skip repos that are not in the targeted set (targeted refresh only).
      if (targetRepoPaths && !targetRepoPaths.includes(normalizedRepoPath)) {
        continue;
      }

      // Phase 2a: Load pending changes
      const pendingError = await this.loadPendingForRepo(folder, repoRelPath, normalizedRepoPath, newFiles, pendingOnly);
      assertNotCancelled();
      if (pendingError) {
        void this.repoHealth.notifyCorruptIndex(normalizedRepoPath, folder.name, repoRelPath, pendingError);
      }

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
  ): Promise<string | undefined> {
    // --- Phase 2: Pending changes (fast) ---
    try {
      const error = await DataCollector.collectPendingForRepo(folder, repoRelPath, newFiles);

      // If historical mode, keep a secondary indicator so children show a history spinner.
      if (!pendingOnly) {
        this.load.reposLoadingHistorical.add(normalizedRepoPath);
      }
      this._setFreshFiles(new Map(newFiles));
      return error;
    } finally {
      // Transition: pending loaded → remove spinner, expose pending files immediately.
      this.load.reposLoading.delete(normalizedRepoPath);
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
    const token = this.load.captureEpoch();
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
        this.fireRepoScoped(normalizedRepoPath);
        log(`Incremental update for ${normalizedRepoPath}: ${partial.size} file(s) at ≤${days}d`);
      } else log(`Incremental update skipped (no changes at ≤${days}d)`);

    };

    const commitStatsMap = new Map<string, CommitStats>();
    try {
      const loadStarted = Date.now();
      const { error: repoError, fullData } = await DataCollector.collectHistoricalForRepo(
        folder,
        repoRelPath,
        maxDays,
        newFiles,
        newHistoricalFiles,
        histDays,
        this.repoScope.getPathspec(normalizedRepoPath),
        thresholds,
        onThresholdCrossed,
        commitStatsMap,
      );

      if (!repoError && fullData.size > 0) {
        this.historicalCache.setEntry(normalizedRepoPath, fullData, maxDays, this.repoScope.getPathspec(normalizedRepoPath), commitStatsMap);
        log(`Cached ${fullData.size} file(s) for ${normalizedRepoPath}`);
      }
      if (!repoError) {
        // Slow successful load → suggest a commit-graph (no-op below the threshold).
        void this.repoHealth.notifyIfMissingCommitGraph(normalizedRepoPath, Date.now() - loadStarted);
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
      this.load.reposLoadingHistorical.delete(normalizedRepoPath);
      this._onDidChangeTreeData.fire();
    }
  }

  /**
   * Replace freshFiles, rebuild the path index, and invalidate the stats cache.
   * All internal assignments to freshFiles must go through here.
   */
  
  /**
   * Fire a tree-data change scoped to one repo's subtree when that repo's root
   * item is in the cache, else fall back to a full-tree refresh.
   *
   * Incremental historical loading fires a threshold update per time-window per
   * repo. A bare `fire()` invalidates the WHOLE tree, so VS Code re-renders
   * every *other* repo's expanded subtree too — turning a load of N small repos
   * into O(N²) re-render work (each repo's update re-renders all repos loaded so
   * far). With many sibling worktrees of one repo this dominates: standalone
   * `git status` stays ~35ms but per-repo load time climbs linearly. Scoping the
   * update to the repo that actually changed keeps each one O(1) in repo count.
   * The repo's file-count label is refreshed by the full `fire()` at pending /
   * historical completion, so a briefly-stale count mid-load is acceptable.
   */
  private fireRepoScoped(normalizedRepoPath: NormalizedRepoPath): void {
    const repoItem = this._repoItemCache.get("repo:" + vscode.Uri.file(normalizedRepoPath).fsPath);
    this._onDidChangeTreeData.fire(repoItem);
  }

  private _setFreshFiles(map: Map<AbsolutePath, FileMetadata>): void {
    this._freshFiles = map;
    // The flat lenses (group-by-author/commit, search) have no folder-node
    // context, so they get an owner-filtered view. The File Structure / Flat
    // List trees evaluate files.exclude PER NODE at render time (see buildTree /
    // buildFlatList / buildRepoView) — a file can be hidden under one root yet
    // shown under another — so their index is built from the raw map.
    this._displayFreshFiles = this.filesExcludeFilter.filterByOwner(map, this.workspaceFolders);
    this.fileIndex.rebuild(map);
  }

  /**
   * React to a `files.exclude` or respect-toggle change: drop compiled matchers,
   * recompute the display view + tree index from the unchanged raw data, and
   * re-render. No git I/O — this is a `refreshTreeOnly`-class operation.
   */
  applyFilesExcludeChange(): void {
    this.filesExcludeFilter.invalidate();
    this._setFreshFiles(this._freshFiles);
    this.refreshTreeOnly();
  }

  getCacheStats(): CacheRepoStats[] {
    return this.historicalCache.getStats(this.workspaceFolders);
  }

  private _dirStats() {
    const excludeOn = this.filesExcludeFilter.enabled;
    return this.fileIndex.ensureDirStats(
      this._freshFiles,
      (m) => this.filterManager.passesFilters(m),
      (p) => this.passesRepoScope(p) && !(excludeOn && this.filesExcludeFilter.isExcludedByOwner(p, this.workspaceFolders)),
      ConfigService.getDescriptionFormat().showLineChanges,
    );
  }

  private countFilesInDirectory(dirPath: string): number {
    return this._dirStats().get(asAbsolutePath(dirPath))?.count ?? 0;
  }

  getMostRecentDateInDirectory(dirPath: string): Date | undefined {
    return this._dirStats().get(asAbsolutePath(dirPath))?.mostRecent;
  }

}
