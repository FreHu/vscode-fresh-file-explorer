import * as vscode from "vscode";
import * as path from "path";

import { ConfigService } from "../config/configService";
import { HistoricalFileCache, type CacheRepoStats } from "./historicalFileCache";
import { FileIndex } from "./fileIndex";
export type { CacheRepoStats };
import {
  WorkspaceFolderInfo,
  FileMetadata,
  AuthorData,
  BranchName,
  CommitHash,
  CommitAuthor,
  asCommitAuthor,
  CommitDataWithFileCount,
  asCommitMessage,
  SortOrder,
} from "../types";
import { buildTimeWindows, isPendingChangesMode, TimeWindow } from "./timeWindowUtils";
import { AbsolutePath, asAbsolutePath } from "../pathTypes";
import { formatFileDescription, formatFileTooltip, formatDirectoryTooltip, formatGroupDescription } from "../utils/formatUtils";
import { log, showWarning } from "../extension/logger";
import { FreshFileItem, MessageTreeItem as MessageTreeItem, FreshFilesTreeItem, isAuthorGroup, isCommitHashGroup, isMoonPhaseGroup, isRetrogradeGroup } from "./freshFileTreeItems";
import { normalizePath } from "../utils";
import { GroupingMode, DEFAULT_GROUPING_MODE } from "./groupingMode";
import { type MoonPhase } from "./moonPhase";
import { clearRetrogradeCache } from "./planetaryRetrograde";
import { FilterManager } from "./freshFileFilterManager";
import { GroupingViewBuilder } from "./groupingViewBuilder";
import { DataCollector, RepoInfo } from "./dataCollector";
import { NormalizedRepoPath } from "../pathTypes";
import { findWorkspaceFolderForPath, getRelativeDepth, getParentPathWithinWorkspace } from "../utils/pathUtils";
import { FreshFileItemSorter } from "./freshFileItemSorter";
import { ContextManager } from "../extension/contextManager";
import { WorkspaceStateManager } from "../extension/workspaceStateManager";

export class FreshFileProvider implements vscode.TreeDataProvider<FreshFilesTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<FreshFilesTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

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
  private dataLoaded: boolean = false;
  get isDataLoaded(): boolean { return this.dataLoaded; }
  // Set to true once git repos have been discovered (before file loading completes)
  private reposDiscovered: boolean = false;
  // Normalized absolute paths of repos whose initial (pending) file loading is still in progress
  private reposLoading: Set<NormalizedRepoPath> = new Set();
  // Normalized absolute paths of repos that have pending files loaded but historical is still running
  private reposLoadingHistorical: Set<NormalizedRepoPath> = new Set();
  // Incremented on every refresh() so in-flight updateFreshFiles calls can detect staleness
  private refreshEpoch: number = 0;

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

  // Per-repo pathspec filters (normalized repo path → pathspec string).
  // When active, git log is restricted to the given pathspec for that repo.
  private repoPathspecs: Map<NormalizedRepoPath, string> = new Map();

  // Per-repo folder scope (normalized repo path → normalized absolute folder path).
  // Display-only filter: only files under the scoped folder are shown.
  // Does NOT trigger a git reload — this can only narrow down the data we already have.
  private repoFolderScopes: Map<NormalizedRepoPath, string> = new Map();

  // Target repo paths for the current refresh (undefined = all repos).
  // Set by refresh() to scope updateFreshFiles() to only specific repos.
  private _targetRepoPaths: NormalizedRepoPath[] | undefined = undefined;

  // Cached resolved repo list, populated after discovery and cleared on hard refresh.
  private _resolvedRepos: RepoInfo[] = [];

  readonly historicalCache = new HistoricalFileCache();

  constructor() {
    this.initializeWorkspaceFolders();
    this.timeWindows = this.loadTimeWindows();
    this.currentTimeWindow = this.timeWindows[0]; // Will be overridden by persisted value

    // Set initial context - we're loading
    ContextManager.setLoading(true);

    log(
      `FreshFileProvider initialized with ${this.workspaceFolders.length} workspace folders: ${this.workspaceFolders
        .map(f => f.name)
        .join(", ")}`,
    );
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
    this.openChangesMode = WorkspaceStateManager.getOpenChangesMode();
    this.groupingMode = WorkspaceStateManager.getGroupingMode();
    this.sortOrder = WorkspaceStateManager.getSortOrder();

    this.repoPathspecs = WorkspaceStateManager.getRepoPathspecs();
    this.repoFolderScopes = WorkspaceStateManager.getRepoFolderScopes();

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

  onConfigurationChanged(): void {
    log("Configuration changed, hard refreshing");
    this.timeWindows = this.loadTimeWindows();
    // If the current window was removed from the configured list, fall back to another one.
    const currentStillValid = this.timeWindows.find(tw => {
      if (tw.type === "pending" && this.currentTimeWindow.type === "pending") { return true; }
      return tw.type === "historical" && this.currentTimeWindow.type === "historical" && tw.days === this.currentTimeWindow.days;
    });
    if (!currentStillValid) {
      this.currentTimeWindow = this.timeWindows.length > 1 ? this.timeWindows[1] : this.timeWindows[0];
    }
    this.hardRefresh();
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
    log(`Refreshing files${scopeDesc} (skipping repo discovery) with time window: ${this.currentTimeWindow.label}`);
    ContextManager.setLoading(true);
    this.dataLoaded = false;
    this._targetRepoPaths = targetRepoPaths;
    this.refreshEpoch++;
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
  }

  /**
   * Hard refresh: re-discover repositories then reload all files.
   * Use this when the repo list may have changed (refresh button, workspace folder change).
   */
  hardRefresh(): void {
    log(`Hard refresh (re-discovering repos) with time window: ${this.currentTimeWindow.label}`);
    ContextManager.setLoading(true);
    this.dataLoaded = false;
    this.reposDiscovered = false;
    this._resolvedRepos = [];
    this.reposLoading.clear();
    this.reposLoadingHistorical.clear();
    this.refreshEpoch++;
    this._setFreshFiles(new Map());
    this.historicalCache.clear();
    clearRetrogradeCache();
    this._onDidChangeTreeData.fire();
  }

  // Cumulative stats across all buildTree calls since the last tree-refresh event.
  // Lets us see the total rendering cost once VS Code finishes calling getChildren.
  private _renderPass = { calls: 0, totalMs: 0, totalScanned: 0 };

  /** Refresh the tree display without reloading data from git */
  refreshTreeOnly(): void {
    this._renderPass = { calls: 0, totalMs: 0, totalScanned: 0 };
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
    await this.updatePendingFiles(targetRepoPaths);
    this._onDidChangeTreeData.fire();
  }

  private async updatePendingFiles(targetRepoPaths?: NormalizedRepoPath[]): Promise<void> {
    if (this.workspaceFolders.length === 0) {
      return;
    }

    if (targetRepoPaths) {
      // Targeted update: only query the repos that changed.
      const targetFolders = buildTargetWorkspaceFolders(this.workspaceFolders, targetRepoPaths);
      const pendingFiles = await DataCollector.collectPendingFiles(targetFolders);

      // Merge strategy:
      // 1. Historical baseline for target repos (reset to committed state).
      // 2. Current freshFiles entries for non-target repos (preserve their state).
      // 3. Fresh pending entries for target repos (override historical baseline).
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
      this._setFreshFiles(merged);
    } else {
      const pendingFiles = await DataCollector.collectPendingFiles(this.workspaceFolders);
      // Rebuild freshFiles from cached historical baseline + new pending entries.
      // This restores historical entries for files whose pending changes were reverted.
      const merged = new Map<AbsolutePath, FileMetadata>(this.historicalCache.historicalFiles);
      for (const [absolutePath, metadata] of pendingFiles) {
        merged.set(absolutePath, metadata);
      }
      this._setFreshFiles(merged);
    }
  }

  setTimeWindow(timeWindow: TimeWindow): void {
    log(`Time window changed from ${this.currentTimeWindow.label} to ${timeWindow.label}`);
    this.currentTimeWindow = timeWindow;
    this.filterManager.clearFilters();
    if (timeWindow.type === "historical") {
      WorkspaceStateManager.setSelectedTimeWindowDays(timeWindow.days);
      // Serve from cache if all repos have a valid cached result that covers this window.
      if (this.historicalCache.canServeWindow(timeWindow.days, this.workspaceFolders, this.repoPathspecs)) {
        log(`Serving time window ${timeWindow.label} from cache`);
        this.refreshEpoch++; // cancel any in-flight updateFreshFiles
        this.dataLoaded = true;
        this._setFreshFiles(this.historicalCache.applyWindowToFiles(timeWindow.days, this.workspaceFolders, this.repoPathspecs, this.freshFiles));
        this.refreshTreeOnly();
        return;
      }
      // An in-flight load always targets the maximum configured interval.
      // If there's a load in progress and it covers the new window, don't cancel it —
      // the incremental cache updates will apply the new window as each threshold is crossed.
      const configuredMaxDays = Math.max(0, ...this.historicalTimeWindows.map(tw => tw.days));
      if (this.refreshPromise && configuredMaxDays >= timeWindow.days) {
        log(`Time window set to ${timeWindow.label} — in-flight load (maxDays=${configuredMaxDays}) will cover it, not cancelling`);
        this.refreshTreeOnly();
        return;
      }
    } else if (timeWindow.type === "pending" && this.dataLoaded) {
      // Pending files are already present in freshFiles — no git operations needed.
      log(`Serving pending window from existing data`);
      this.refreshEpoch++; // cancel any in-flight updateFreshFiles
      this._setFreshFiles(this.historicalCache.applyPendingOnly(this.freshFiles));
      this.refreshTreeOnly();
      return;
    }
    this.refresh({ preserveHistoricalCache: true }); // soft — repos unchanged; keep cache for other windows
  }

  toggleOpenMode(): void {
    this.openChangesMode = !this.openChangesMode;
    log(`Toggled open mode: ${this.openChangesMode ? "changes" : "file"}`);

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
    if (trimmed) {
      log(`Setting pathspec for ${normalizedRepoPath}: ${trimmed}`);
      this.repoPathspecs.set(normalizedRepoPath, trimmed);
    } else {
      log(`Clearing pathspec for ${normalizedRepoPath}`);
      this.repoPathspecs.delete(normalizedRepoPath);
    }
    WorkspaceStateManager.setRepoPathspec(normalizedRepoPath, trimmed || undefined);
    this.refresh({ targetRepoPaths: [normalizedRepoPath] });
  }

  /** Return the active pathspec for a repo, or undefined if none is set. */
  getRepoPathspec(normalizedRepoPath: NormalizedRepoPath): string | undefined {
    return this.repoPathspecs.get(normalizedRepoPath);
  }

  /**
   * Scope the display of a repo to a specific folder (display-only, no git reload).
   * Only files whose path starts with `normalizedFolderPath` will be shown.
   * Pass undefined to clear the scope.
   */
  setFolderScope(normalizedRepoPath: NormalizedRepoPath, normalizedFolderPath: string | undefined): void {
    if (normalizedFolderPath) {
      log(`Scoping repo ${normalizedRepoPath} to folder: ${normalizedFolderPath}`);
      this.repoFolderScopes.set(normalizedRepoPath, normalizedFolderPath);
    } else {
      log(`Clearing folder scope for repo ${normalizedRepoPath}`);
      this.repoFolderScopes.delete(normalizedRepoPath);
    }
    WorkspaceStateManager.setRepoFolderScope(normalizedRepoPath, normalizedFolderPath);
    this.refreshTreeOnly();
  }

  /** Return the active folder scope for a repo, or undefined if none is set. */
  getFolderScope(normalizedRepoPath: NormalizedRepoPath): string | undefined {
    return this.repoFolderScopes.get(normalizedRepoPath);
  }

  /**
   * Returns true if the file passes the folder scope filter for its repo.
   * When no scope is active for the repo, all files pass.
   */
  private passesRepoScope(normalizedFilePath: string): boolean {
    if (this.repoFolderScopes.size === 0) {
      return true;
    }
    // Find which repo this file belongs to, then check its scope
    for (const { normalizedRepoPath } of this.resolvedRepos) {
      if (normalizedFilePath.startsWith(normalizedRepoPath + "/") || normalizedFilePath === normalizedRepoPath) {
        const scope = this.repoFolderScopes.get(normalizedRepoPath);
        if (scope === undefined) {
          return true; // No scope for this repo
        }
        return normalizedFilePath.startsWith(scope + "/") || normalizedFilePath === scope;
      }
    }
    return true;
  }

  private updateGroupingModeMessage(): void {
    if (!this.treeView) {
      return;
    }
    if (this.groupingMode === "fileStructure") {
      this.treeView.message = undefined;
    } else {
      this.treeView.message =
        "Note: Only the most recent commit per file is examined. " +
        "If a file was modified by multiple authors or commits in " +
        "the selected period, only the latest change is shown.";
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

  getTreeItem(element: FreshFilesTreeItem): vscode.TreeItem {
    return element;
  }

  getParent(element: FreshFilesTreeItem): FreshFilesTreeItem | undefined {
    if (!(element instanceof FreshFileItem)) {
      return undefined;
    }

    const folder = findWorkspaceFolderForPath(asAbsolutePath(element.resourceUri.fsPath), this.workspaceFolders);
    if (!folder) {
      return undefined;
    }

    const parentPath = getParentPathWithinWorkspace(element.resourceUri.fsPath, folder.path);
    if (!parentPath) {
      // Item is at root level of this workspace folder, no parent
      return undefined;
    }

    const parentUri = vscode.Uri.file(parentPath);
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
      if (!this.dataLoaded && !this.refreshPromise) {
        log("Loading files from Git repositories...");
        this.refreshPromise = this.updateFreshFiles().finally(() => {
          this.refreshPromise = undefined;
          // If another refresh() arrived while we were loading, start a fresh load.
          if (!this.dataLoaded) {
            log("Stale load detected after promise settled — starting new load");
            this.refreshPromise = this.updateFreshFiles().finally(() => {
              this.refreshPromise = undefined;
            });
          }
        });
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

      // Check if no files found — but only when loading is fully complete.
      // While repos are still loading (pending or historical phase), fall through to
      // buildRepoView so the per-repo loading spinners are shown instead of the empty message.
      if (this.freshFiles.size === 0 && this.reposLoading.size === 0 && this.reposLoadingHistorical.size === 0) {
        const message = isPendingChangesMode(this.currentTimeWindow)
          ? "No pending changes"
          : `No files modified in the last ${this.currentTimeWindow.label}`;
        results.push(new MessageTreeItem(message, "info"));
        return results;
      }

      // Show root folder node only if there is a single workspace folder and a single repo
      if (this.workspaceFolders.length === 1 && this.workspaceFolders[0].gitRepos.length === 1) {
        return this.buildRepoView(results, "workspaceFolder");
      } else {
        return this.buildRepoView(results, "repoFolder");
      }
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
      const children: FreshFilesTreeItem[] = this.buildTree(element.resourceUri.fsPath);
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

    // Future consideration: A flat list view mode would be added here
    // It would bypass buildTree() and create a single sorted array from freshFiles.values()
    // The sortOrder state would be reused for consistent sorting behavior

    if (this.groupingMode !== "fileStructure") {
      return GroupingViewBuilder.buildForGroupingMode(
        this.groupingMode,
        this.freshFiles,
        (metadata) => this.filterManager.passesFilters(metadata),
        this.openChangesMode,
        results,
      );
    }

    // Default: group by file structure
    for (const { folder, repoRelPath, repoFullPath, normalizedRepoPath } of this.resolvedRepos) {
      const repoName = repoRelPath || folder.name;
      const activeFolderScope = this.repoFolderScopes.get(normalizedRepoPath);

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
      const activePathspec = this.repoPathspecs.get(normalizedRepoPath);

      // Compute a display-friendly folder scope label
      const folderScopeDisplay = activeFolderScope
        ? normalizePath(path.relative(repoFullPath, activeFolderScope))
        : undefined;

      // Respect auto-expand depth setting for repository roots
      const shouldExpand = ConfigService.getAutoExpandDepth() > 0 && fileCount > 0;

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

  /** Returns true if a file passes the current visibility filters. */
  private isFileVisible(metadata: FileMetadata): boolean {
    return !metadata.isDeleted && this.filterManager.passesFilters(metadata);
  }

  private async updateFreshFiles(): Promise<void> {
    if (this.workspaceFolders.length === 0) {
      return;
    }

    const epoch = this.refreshEpoch;
    const assertNotCancelled = () => {
      if (this.refreshEpoch !== epoch) { throw new RefreshCancelledError(); }
    };

    try {
      // --- Phase 1: Discover repositories (skipped on soft refresh) ---
      await this.discoverRepositories(assertNotCancelled);

      const totalRepos = this.totalRepoCount;
      if (totalRepos === 0) {
        ContextManager.setLoading(false);
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
      ContextManager.setLoading(false);
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
    // Also back-fill folder.gitRepos for consumers that accept WorkspaceFolderInfo[] directly.
    for (const folder of this.workspaceFolders) {
      folder.gitRepos = [];
    }
    for (const repo of discoveredRepos) {
      repo.folder.gitRepos.push(repo.repoRelPath);
    }
    this._resolvedRepos = discoveredRepos;

    log(`Discovered ${this.totalRepoCount} Git repository(ies) across ${this.workspaceFolders.length} workspace folder(s)`);

    // Mark all repos as loading and fire so the repo list appears immediately
    // with per-repo spinners before any git log commands have run.
    for (const { normalizedRepoPath } of this.resolvedRepos) {
      this.reposLoading.add(normalizedRepoPath);
    }

    this.reposDiscovered = true;
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
          const badPathspec = this.repoPathspecs.get(normalizedRepoPath);
          this.repoPathspecs.delete(normalizedRepoPath);
          WorkspaceStateManager.clearRepoPathspec(normalizedRepoPath);
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
    await DataCollector.collectPendingForRepo(folder, repoRelPath, newFiles);

    // Transition: pending loaded → remove spinner, expose pending files immediately.
    // If historical mode, keep a secondary indicator so children show a history spinner.
    this.reposLoading.delete(normalizedRepoPath);
    if (!pendingOnly) {
      this.reposLoadingHistorical.add(normalizedRepoPath);
    }
    this._setFreshFiles(new Map(newFiles));
    this._onDidChangeTreeData.fire();
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
    const capturedEpoch = this.refreshEpoch;
    const onThresholdCrossed = (days: number, partial: Map<AbsolutePath, FileMetadata>) => {
      if (this.refreshEpoch !== capturedEpoch) { return; }

      // Update the historical cache incrementally so that a time-window switch
      // to any already-loaded window can be served instantly without re-running git.
      this.historicalCache.upgradeEntry(normalizedRepoPath, days, partial, this.repoPathspecs.get(normalizedRepoPath));

      // If the user switched to a smaller window while this load was in-flight,
      // filter the display to that window so we don't over-expose data.
      const currentDays = this.currentTimeWindow.type === "historical" ? this.currentTimeWindow.days : undefined;
      let displayPartial = partial;
      if (currentDays !== undefined && currentDays < days && this.historicalCache.canServeWindow(currentDays, this.workspaceFolders, this.repoPathspecs)) {
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
      this._setFreshFiles(merged);
      this._onDidChangeTreeData.fire();
      log(`Incremental update for ${normalizedRepoPath}: ${partial.size} file(s) at ≤${days}d`);
    };

    const { error: repoError, fullData } = await DataCollector.collectHistoricalForRepo(
      folder,
      repoRelPath,
      maxDays,
      newFiles,
      newHistoricalFiles,
      this.repoPathspecs.get(normalizedRepoPath),
      thresholds,
      onThresholdCrossed,
    );

    if (!repoError && fullData.size > 0) {
      this.historicalCache.setEntry(normalizedRepoPath, fullData, maxDays, this.repoPathspecs.get(normalizedRepoPath));
      log(`Cached ${fullData.size} file(s) for ${normalizedRepoPath} (maxDays=${maxDays})`);
    }

    this.reposLoadingHistorical.delete(normalizedRepoPath);
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
    this._onDidChangeTreeData.fire();

    return repoError;
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

  private buildTree(parentPath: string): FreshFileItem[] {
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

    const items: FreshFileItem[] = [];

    for (const childPath of directChildren) {
      const isFile = this._freshFiles.has(childPath);
      const name = childPath.substring(normalizedParent.length + 1);
      const fullPath = path.join(parentPath, name);
      const uri = vscode.Uri.file(fullPath);

      if (isFile) {
        const metadata = this._freshFiles.get(childPath)!;
        if (!this.filterManager.passesFilters(metadata)) { continue; }
        if (!this.passesRepoScope(childPath)) { continue; }

        const item = FreshFileItem.forFile(
          uri, this.openChangesMode,
          metadata.isDeleted ?? false,
          metadata.commitHash,
          metadata.isPending ?? false,
          metadata.status,
        );
        item.description = formatFileDescription(metadata, descriptionFormat);
        item.tooltip = formatFileTooltip(metadata);
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
      (item) => item.isDirectory
        ? dirStats.get(asAbsolutePath(item.resourceUri.fsPath))?.mostRecent
        : this._freshFiles.get(asAbsolutePath(item.resourceUri.fsPath))?.date,
      (item) => item.isDirectory
        ? ""
        : (this._freshFiles.get(asAbsolutePath(item.resourceUri.fsPath))?.author || ""),
    );

    return items;
  }
}

/** Thrown when a newer refresh has started and the current load should be abandoned. */
class RefreshCancelledError extends Error {
  constructor() { super("refresh cancelled"); }
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
