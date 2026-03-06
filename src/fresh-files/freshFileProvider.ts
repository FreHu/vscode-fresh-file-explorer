import * as vscode from "vscode";
import * as path from "path";
import * as v8 from "v8";

import { ConfigService } from "../config/configService";
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
import { FreshFileItem, MessageTreeItem as MessageTreeItem, FreshFilesTreeItem, NoteTreeItem, isPinnedFolder, isAuthorGroup, isCommitHashGroup, isMoonPhaseGroup, isRetrogradeGroup } from "./freshFileTreeItems";
import { normalizePath } from "../utils";
import { GroupingMode, DEFAULT_GROUPING_MODE } from "./groupingMode";
import { type MoonPhase } from "./moonPhase";
import { clearRetrogradeCache } from "./planetaryRetrograde";
import { TreeItemContextValues, createPinnedFileId } from "./treeItemConstants";
import { PinnedItemsManager } from "./pinnedItemsManager";
import { FilterManager } from "./freshFileFilterManager";
import { GroupingViewBuilder } from "./groupingViewBuilder";
import { DataCollector } from "./dataCollector";
import { findWorkspaceFolderForPath, getRelativeDepth, getParentPathWithinWorkspace } from "../utils/pathUtils";
import { FreshFileItemSorter } from "./freshFileItemSorter";
import { ContextManager } from "../extension/contextManager";
import { WorkspaceStateManager } from "../extension/workspaceStateManager";

export interface CacheRepoStats {
  repoLabel: string;
  repoPath: string;
  entryCount: number;
  sizeBytes: number;
}

export class FreshFileProvider implements vscode.TreeDataProvider<FreshFilesTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<FreshFilesTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // Map of absolute file path to file metadata
  private _freshFiles: Map<AbsolutePath, FileMetadata> = new Map();
  get freshFiles(): Map<AbsolutePath, FileMetadata> { return this._freshFiles; }

  // Path index: normalized parent path → set of normalized direct child paths (files + subdirs).
  // Rebuilt whenever _freshFiles changes. Turns O(n) buildTree scans into O(children).
  private _pathIndex: Map<string, Set<string>> = new Map();

  // Per-render-pass directory stats: normalized dir path → {count, mostRecent, lines}.
  // Built lazily in one O(n) pass on first query; nulled by refreshTreeOnly / _setFreshFiles.
  private _dirStatsCache: Map<string, { count: number; mostRecent: Date | undefined; linesAdded: number; linesDeleted: number }> | null = null;
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
  private reposLoading: Set<string> = new Set();
  // Normalized absolute paths of repos that have pending files loaded but historical is still running
  private reposLoadingHistorical: Set<string> = new Set();
  // Incremented on every refresh() so in-flight updateFreshFiles calls can detect staleness
  private refreshEpoch: number = 0;

  // Sync status warnings
  private syncWarnings: string[] = [];

  // Branch names for repositories (from Git extension API)
  private repoBranches: Map<string, BranchName> = new Map();

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
  private pinnedItemsManager = new PinnedItemsManager();
  private filterManager = new FilterManager();

  // Incremented every time refreshPending() runs, so external listeners can detect
  // that a pending refresh already happened and skip scheduling a duplicate.
  pendingRefreshVersion: number = 0;

  // Per-repo pathspec filters (normalized repo path → pathspec string).
  // When active, git log is restricted to the given pathspec for that repo.
  private repoPathspecs: Map<string, string> = new Map();

  // Per-repo folder scope (normalized repo path → normalized absolute folder path).
  // Display-only filter: only files under the scoped folder are shown.
  // Does NOT trigger a git reload — this can only narrow down the data we already have.
  private repoFolderScopes: Map<string, string> = new Map();

  // Historical (committed) file entries cached from the last full refresh.
  // Kept separate from freshFiles so pending-only refreshes can restore them
  // when a file's uncommitted changes are reverted.
  private historicalFiles: Map<AbsolutePath, FileMetadata> = new Map();

  // Cache of historical data per repo (normalized repo path → {data, maxDays, pathspec}).
  // Populated after each full historical load. Allows instant window switching without
  // re-running git log when switching to a window that is ≤ the cached maxDays.
  private historicalCache: Map<string, {
    data: Map<AbsolutePath, FileMetadata>;
    /** Entries sorted by date ascending — used for O(log n) window filtering. */
    sortedByDate: ReadonlyArray<readonly [AbsolutePath, FileMetadata]>;
    maxDays: number;
    pathspec: string | undefined;
  }> = new Map();

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
    this.pinnedItemsManager.initialize(() => this.refreshTreeOnly());
    this.filterManager.initialize(() => this.refreshTreeOnly());

    // Load persisted time window selection
    const persistedDays = WorkspaceStateManager.getSelectedTimeWindowDays();
    this.openChangesMode = WorkspaceStateManager.getOpenChangesMode();
    this.groupingMode = WorkspaceStateManager.getGroupingMode();
    this.sortOrder = WorkspaceStateManager.getSortOrder();

    const storedPathspecs = WorkspaceStateManager.getRepoPathspecs();
    this.repoPathspecs = new Map(Object.entries(storedPathspecs));

    const storedFolderScopes = WorkspaceStateManager.getRepoFolderScopes();
    this.repoFolderScopes = new Map(Object.entries(storedFolderScopes));

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
  refresh(options?: { preserveHistoricalCache?: boolean }): void {
    if (!this.reposDiscovered) {
      this.hardRefresh();
      return;
    }
    const daysText = this.currentTimeWindow.type === "historical" ? ` (${this.currentTimeWindow.days} days)` : "";
    log(`Refreshing files (skipping repo discovery) with time window: ${this.currentTimeWindow.label}${daysText}`);
    ContextManager.setLoading(true);
    this.dataLoaded = false;
    this._setFreshFiles(new Map());
    this.historicalFiles = new Map();
    if (!options?.preserveHistoricalCache) {
      this.historicalCache.clear();
    }
    this.refreshEpoch++;
    clearRetrogradeCache();
    // Pre-populate reposLoading so spinner appears on each repo node immediately.
    this.reposLoading.clear();
    this.reposLoadingHistorical.clear();
    for (const folder of this.workspaceFolders) {
      for (const repoRelPath of folder.gitRepos) {
        const repoFullPath = repoRelPath ? path.join(folder.path, repoRelPath) : folder.path;
        this.reposLoading.add(normalizePath(repoFullPath));
      }
    }
    this._onDidChangeTreeData.fire();
  }

  /**
   * Hard refresh: re-discover repositories then reload all files.
   * Use this when the repo list may have changed (refresh button, workspace folder change).
   */
  hardRefresh(): void {
    const daysText = this.currentTimeWindow.type === "historical" ? ` (${this.currentTimeWindow.days} days)` : "";
    log(`Hard refresh (re-discovering repos) with time window: ${this.currentTimeWindow.label}${daysText}`);
    ContextManager.setLoading(true);
    this.dataLoaded = false;
    this.reposDiscovered = false;
    this.reposLoading.clear();
    this.reposLoadingHistorical.clear();
    this.refreshEpoch++;
    this._setFreshFiles(new Map());
    this.historicalFiles = new Map();
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
    this._dirStatsCache = null; // filters/scopes may have changed
    this._onDidChangeTreeData.fire();
  }

  /**
   * Refresh only the pending layer, leaving historical data cached.
   * Used when working-tree or index changes are detected but no full refresh is required (e.g. new file created).
   * Falls back to a full refresh if data hasn't been loaded yet.
   */
  async refreshPending(): Promise<void> {
    if (!this.dataLoaded) {
      this.refresh(); // soft if repos known, hard if first load
      return;
    }
    this.pendingRefreshVersion++;
    log("Refreshing pending changes only");
    await this.updatePendingFiles();
    this.heatmapProvider?.fireDidChange();
    this._onDidChangeTreeData.fire();
  }

  private async updatePendingFiles(): Promise<void> {
    if (this.workspaceFolders.length === 0) {
      return;
    }

    const pendingFiles = await DataCollector.collectPendingFiles(this.workspaceFolders);

    // Rebuild freshFiles from cached historical baseline + new pending entries.
    // This restores historical entries for files whose pending changes were reverted.
    const merged = new Map<AbsolutePath, FileMetadata>(this.historicalFiles);
    for (const [absolutePath, metadata] of pendingFiles) {
      merged.set(absolutePath, metadata);
    }
    this._setFreshFiles(merged);
  }

  setTimeWindow(timeWindow: TimeWindow): void {
    log(`Time window changed from ${this.currentTimeWindow.label} to ${timeWindow.label}`);
    this.currentTimeWindow = timeWindow;
    this.filterManager.clearFilters();
    if (timeWindow.type === "historical") {
      WorkspaceStateManager.setSelectedTimeWindowDays(timeWindow.days);
      // Serve from cache if all repos have a valid cached result that covers this window.
      if (this._canServeFromCache(timeWindow.days)) {
        log(`Serving time window ${timeWindow.label} from cache (instant switch)`);
        this.refreshEpoch++; // cancel any in-flight updateFreshFiles
        this.dataLoaded = true;
        this._applyHistoricalCacheToWindow(timeWindow.days);
        this.refreshTreeOnly();
        return;
      }
      // An in-flight load always targets the maximum configured interval.
      // If there's a load in progress and it covers the new window, don't cancel it —
      // the incremental cache updates will apply the new window as each threshold is crossed.
      const configuredMaxDays = Math.max(0, ...this.timeWindows
        .filter((tw): tw is { type: "historical"; label: string; days: number } => tw.type === "historical")
        .map(tw => tw.days));
      if (this.refreshPromise && configuredMaxDays >= timeWindow.days) {
        log(`Time window set to ${timeWindow.label} — in-flight load (maxDays=${configuredMaxDays}) will cover it, not cancelling`);
        this.refreshTreeOnly();
        return;
      }
    } else if (timeWindow.type === "pending" && this.dataLoaded) {
      // Pending files are already present in freshFiles — no git operations needed.
      log(`Serving pending window from existing data (instant switch)`);
      this.refreshEpoch++; // cancel any in-flight updateFreshFiles
      this._applyPendingOnlyFromExisting();
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
  setRepoPathspec(normalizedRepoPath: string, pathspec: string | undefined): void {
    const trimmed = pathspec?.trim();
    if (trimmed) {
      log(`Setting pathspec for ${normalizedRepoPath}: ${trimmed}`);
      this.repoPathspecs.set(normalizedRepoPath, trimmed);
    } else {
      log(`Clearing pathspec for ${normalizedRepoPath}`);
      this.repoPathspecs.delete(normalizedRepoPath);
    }
    WorkspaceStateManager.setRepoPathspec(normalizedRepoPath, trimmed || undefined);
    this.refresh();
  }

  /** Return the active pathspec for a repo, or undefined if none is set. */
  getRepoPathspec(normalizedRepoPath: string): string | undefined {
    return this.repoPathspecs.get(normalizedRepoPath);
  }

  /**
   * Scope the display of a repo to a specific folder (display-only, no git reload).
   * Only files whose path starts with `normalizedFolderPath` will be shown.
   * Pass undefined to clear the scope.
   */
  setFolderScope(normalizedRepoPath: string, normalizedFolderPath: string | undefined): void {
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
  getFolderScope(normalizedRepoPath: string): string | undefined {
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
    for (const folder of this.workspaceFolders) {
      for (const repoRelPath of folder.gitRepos) {
        const repoFullPath = repoRelPath ? path.join(folder.path, repoRelPath) : folder.path;
        const normalizedRepoPath = normalizePath(repoFullPath);
        if (normalizedFilePath.startsWith(normalizedRepoPath + "/") || normalizedFilePath === normalizedRepoPath) {
          const scope = this.repoFolderScopes.get(normalizedRepoPath);
          if (scope === undefined) {
            return true; // No scope for this repo
          }
          return normalizedFilePath.startsWith(scope + "/") || normalizedFilePath === scope;
        }
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

  /** Set excluded authors (files by these authors will be hidden) */
  setExcludedAuthors(authors: Set<string>): void {
    this.filterManager.setExcludedAuthors(authors);
  }

  /** Set excluded commits (files from these commits will be hidden) */
  setExcludedCommits(commits: Set<CommitHash>): void {
    this.filterManager.setExcludedCommits(commits);
  }

  /** Clear all filters */
  clearFilters(): void {
    this.filterManager.clearFilters();
  }

  /** Check if any filters are active */
  hasActiveFilters(): boolean {
    return this.filterManager.hasActiveFilters();
  }

  /** Get current filter summary for display */
  getFilterSummary(): string {
    return this.filterManager.getFilterSummary();
  }

  /** Get excluded authors (for external access) */
  getExcludedAuthors(): Set<string> {
    return this.filterManager.getExcludedAuthors();
  }

  /** Get excluded commits (for external access) */
  getExcludedCommits(): Set<CommitHash> {
    return this.filterManager.getExcludedCommits();
  }

  /** Get excluded authors set (for FilterProvider interface compatibility) */
  get excludedAuthors(): Set<string> {
    return this.filterManager.getExcludedAuthors();
  }

  /** Get excluded commits set (for FilterProvider interface compatibility) */
  get excludedCommits(): Set<CommitHash> {
    return this.filterManager.getExcludedCommits();
  }

  /** Add file(s) to pinned items */
  pinFiles(filePaths: AbsolutePath[]): void {
    this.pinnedItemsManager.pinFiles(filePaths);
  }

  /** Remove file(s) from pinned items */
  unpinFiles(filePaths: AbsolutePath[]): void {
    this.pinnedItemsManager.unpinFiles(filePaths);
  }

  /** Check if a file is pinned */
  isPinned(filePath: AbsolutePath): boolean {
    return this.pinnedItemsManager.isPinned(filePath);
  }

  /** Get all pinned files */
  getPinnedFiles(): AbsolutePath[] {
    return this.pinnedItemsManager.getPinnedFiles();
  }

  /** Add a note to pinned items */
  addNote(noteText: string): void {
    this.pinnedItemsManager.addNote(noteText);
  }

  /** Remove a note from pinned items */
  removeNote(noteId: string): void {
    this.pinnedItemsManager.removeNote(noteId);
  }

  /** Update a note's text */
  updateNote(noteId: string, noteText: string): void {
    this.pinnedItemsManager.updateNote(noteId, noteText);
  }

  /** Toggle a note's completed state (for todo-style notes) */
  toggleNoteCompleted(noteId: string): void {
    this.pinnedItemsManager.toggleNoteCompleted(noteId);
  }

  /** Clear all pinned items (files and notes) */
  clearAllPinned(): void {
    this.pinnedItemsManager.clearAllPinned();
  }

  /** Clear only completed notes */
  clearCompleted(): void {
    this.pinnedItemsManager.clearCompleted();
  }

  /** Reorder pinned items */
  reorderPinnedItems(sourceId: string, targetId: string, dropBefore: boolean): void {
    this.pinnedItemsManager.reorderPinnedItems(sourceId, targetId, dropBefore);
  }

  /** Move a pinned item to the first position */
  movePinnedItemToFirst(sourceId: string): void {
    this.pinnedItemsManager.movePinnedItemToFirst(sourceId);
  }

  /** Pin files at a specific position (0 = first) */
  pinFilesAtPosition(filePaths: AbsolutePath[], position: number): void {
    this.pinnedItemsManager.pinFilesAtPosition(filePaths, position);
  }

  /** Pin files after a specific item */
  pinFilesAfterItem(filePaths: AbsolutePath[], afterItemId: string): void {
    this.pinnedItemsManager.pinFilesAfterItem(filePaths, afterItemId);
  }

  /** Get all visible file paths (excluding deleted files) for search operations */
  getVisibleFilePaths(): AbsolutePath[] {
    const files: AbsolutePath[] = [];
    for (const [filePath, metadata] of this.freshFiles.entries()) {
      // Skip deleted files and apply current filters
      if (metadata.isDeleted) {
        continue;
      }
      if (!this.filterManager.passesFilters(metadata)) {
        continue;
      }
      files.push(filePath);
    }
    return files;
  }

  /** Get all visible files with their metadata (excluding deleted files) */
  getVisibleFilesWithMetadata(): Map<AbsolutePath, FileMetadata> {
    const files = new Map<AbsolutePath, FileMetadata>();
    for (const [filePath, metadata] of this.freshFiles.entries()) {
      // Skip deleted files and apply current filters
      if (metadata.isDeleted) {
        continue;
      }
      if (!this.filterManager.passesFilters(metadata)) {
        continue;
      }
      files.set(filePath, metadata);
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
  setRepoBranches(branches: Map<string, BranchName>, silent = false): void {
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

    // Create a parent FreshFileItem (directory)
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

      // Collect results: sync warnings, pinned folder, then files or empty message
      const results: FreshFilesTreeItem[] = [];

      // Always show sync warnings at the top
      if (this.syncWarnings.length > 0) {
        results.push(...this.syncWarnings.map(w => new MessageTreeItem(w, "warning")));
      }

      // Add pinned items folder after warnings
      if (this.pinnedItemsManager.getCount() > 0 || totalRepos > 0) {
        // Use a virtual URI for the pinned folder
        const pinnedFolderUri = vscode.Uri.parse("freshfiles://pinned");
        const pinnedFolder = FreshFileItem.forPinnedFolder(
          pinnedFolderUri,
          this.openChangesMode,
          this.pinnedItemsManager.getCount(),
          ConfigService.getAutoExpandDepth() > 0,
        );
        results.push(pinnedFolder);
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

    if (isPinnedFolder(element)) {
      return this.buildPinnedItems();
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
      const normalizedPath = normalizePath(element.resourceUri.fsPath);
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

    // If grouping by author, build a different structure
    if (this.groupingMode === "author") {
      return GroupingViewBuilder.buildAuthorGroupedView(
        this.freshFiles,
        (metadata) => this.filterManager.passesFilters(metadata),
        this.openChangesMode,
        results,
      );
    }

    // If grouping by commit hash, build a different structure
    if (this.groupingMode === "commitHash") {
      return GroupingViewBuilder.buildCommitHashGroupedView(
        this.freshFiles,
        (metadata) => this.filterManager.passesFilters(metadata),
        this.openChangesMode,
        results,
      );
    }

    // If grouping by moon phase, build a different structure
    if (this.groupingMode === "moonPhase") {
      return GroupingViewBuilder.buildMoonPhaseGroupedView(
        this.freshFiles,
        (metadata) => this.filterManager.passesFilters(metadata),
        this.openChangesMode,
        results,
      );
    }

    // If grouping by planetary retrograde, build a different structure
    if (this.groupingMode === "retrograde") {
      return GroupingViewBuilder.buildRetrogradeGroupedView(
        this.freshFiles,
        (metadata) => this.filterManager.passesFilters(metadata),
        this.openChangesMode,
        results,
      );
    }

    // Default: group by file structure
    for (const folder of this.workspaceFolders) {
      for (const repo of folder.gitRepos) {
        const repoPath = repo ? path.join(folder.path, repo) : folder.path;
        const repoName = repo ? repo : folder.name;
        const repoNormalized = normalizePath(repoPath);

        const activeFolderScope = this.repoFolderScopes.get(repoNormalized);

        const filesInRepo = Array.from(this.freshFiles.keys()).filter(filePath => {
          const normalized = normalizePath(filePath);
          // File must be in this repo
          if (normalized !== repoNormalized && !normalized.startsWith(repoNormalized + "/")) {
            return false;
          }
          if (activeFolderScope && !normalized.startsWith(activeFolderScope + "/") && normalized !== activeFolderScope) {
            return false;
          }
          return true;
        });

        const fileCount = filesInRepo.length;

        const repoUri = vscode.Uri.file(repoPath);
        const branchName = this.repoBranches.get(repoNormalized);
        const isLoading = this.reposLoading.has(repoNormalized);
        const isLoadingHistorical = this.reposLoadingHistorical.has(repoNormalized);
        const activePathspec = this.repoPathspecs.get(repoNormalized);

        // Compute a display-friendly folder scope label
        const folderScopeDisplay = activeFolderScope
          ? normalizePath(path.relative(repoPath, activeFolderScope))
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
    }
    return results;
  }

  private buildPinnedItems(): FreshFilesTreeItem[] {
    const items: FreshFilesTreeItem[] = [];

    // Iterate in order
    for (const pinnedItem of this.pinnedItemsManager.getItems()) {
      if (pinnedItem.type === "note") {
        items.push(new NoteTreeItem(pinnedItem.id, pinnedItem.data, pinnedItem.completed ?? false));
      } else {
        // File
        const filePath = asAbsolutePath(pinnedItem.id);
        const uri = vscode.Uri.file(filePath);

        // Check if file exists in freshFiles to get metadata
        const metadata = this.freshFiles.get(filePath);

        // Create file item
        const item = FreshFileItem.forFile(
          uri,
          this.openChangesMode,
          metadata?.isDeleted ?? false,
          metadata?.commitHash,
          metadata?.isPending ?? false,
          metadata?.status,
        );

        // Mark as pinned file for context menu
        item.contextValue = TreeItemContextValues.PINNED_FILE;

        // Use unique ID to allow same file in both pinned and regular view
        item.id = createPinnedFileId(uri.fsPath);

        // Always show directory path in description for pinned items (excluding filename)
        const folder = findWorkspaceFolderForPath(filePath, this.workspaceFolders);
        if (folder) {
          const relativePath = path.relative(folder.path, filePath);
          const dirPath = path.dirname(relativePath);
          item.description = dirPath === "." ? "" : normalizePath(dirPath);
        } else {
          const dirPath = path.dirname(filePath);
          item.description = normalizePath(dirPath);
        }

        // Tooltip shows git metadata if available
        if (metadata) {
          item.tooltip = formatFileTooltip(metadata);
        } else {
          item.tooltip = filePath;
        }

        items.push(item);
      }
    }

    return items;
  }

  private async updateFreshFiles(): Promise<void> {
    if (this.workspaceFolders.length === 0) {
      return;
    }

    const epoch = this.refreshEpoch;
    const isCancelled = () => this.refreshEpoch !== epoch;

    // --- Phase 1: Discover repositories (skipped on soft refresh) ---
    if (!this.reposDiscovered) {
      await DataCollector.discoverAllRepos(this.workspaceFolders);

      if (isCancelled()) {
        log("updateFreshFiles: cancelled after repo discovery (newer refresh started)");
        return;
      }

      const totalRepos = this.workspaceFolders.reduce((sum, f) => sum + f.gitRepos.length, 0);
      log(`Discovered ${totalRepos} Git repository(ies) across ${this.workspaceFolders.length} workspace folder(s)`);

      if (totalRepos === 0) {
        ContextManager.setLoading(false);
        this.reposDiscovered = true;
        this.dataLoaded = true;
        this._onDidChangeTreeData.fire();
        return;
      }

      // Mark all repos as loading and fire so the repo list appears immediately
      // with per-repo spinners before any git log commands have run.
      for (const folder of this.workspaceFolders) {
        for (const repoRelPath of folder.gitRepos) {
          const repoFullPath = repoRelPath ? path.join(folder.path, repoRelPath) : folder.path;
          this.reposLoading.add(normalizePath(repoFullPath));
        }
      }

      this.reposDiscovered = true;
      this._onDidChangeTreeData.fire(); // Show repo list with per-repo loading indicators
    } else {
      // Soft refresh: repos already known. reposLoading was pre-populated by refresh().
      const totalRepos = this.workspaceFolders.reduce((sum, f) => sum + f.gitRepos.length, 0);
      log(`Reloading files for ${totalRepos} known Git repository(ies) (skipping discovery)`);
    }

    // --- Phase 2: Load files per repository (pending first, then historical) ---
    const newFiles = new Map<AbsolutePath, FileMetadata>();
    const newHistoricalFiles = new Map<AbsolutePath, FileMetadata>();
    let errorToShow: string | undefined;
    const pendingOnly = isPendingChangesMode(this.currentTimeWindow);
    const histDays = this.currentTimeWindow.type === "historical" ? this.currentTimeWindow.days : 0;

    // Compute the maximum historical window — load this much from git in one pass and cache it.
    const historicalWindows = this.timeWindows.filter(
      (tw): tw is { type: "historical"; label: string; days: number } => tw.type === "historical",
    );
    const maxDays = historicalWindows.length > 0 ? historicalWindows[historicalWindows.length - 1].days : histDays;

    // Build the threshold list: day values at which to fire incremental tree updates.
    // Incremental on: update at every configured window ≤ selected, then load the rest silently.
    // Incremental off: one update fires when the selected window is ready.
    const incrementalLoading = ConfigService.getincrementalTreeLoading();
    const thresholds = !pendingOnly
      ? (incrementalLoading
        ? historicalWindows.map(tw => tw.days).filter(d => d <= histDays)
        : [histDays])
      : [];

    for (const folder of this.workspaceFolders) {
      for (const repoRelPath of folder.gitRepos) {
        if (isCancelled()) {
          log("updateFreshFiles: cancelled mid-load (newer refresh started)");
          return;
        }

        const repoFullPath = repoRelPath ? path.join(folder.path, repoRelPath) : folder.path;
        const normalizedRepoPath = normalizePath(repoFullPath);

        // --- Phase 2: Pending changes (fast) ---
        await DataCollector.collectPendingForRepo(folder, repoRelPath, newFiles);

        if (isCancelled()) {
          log("updateFreshFiles: cancelled after pending load (newer refresh started)");
          return;
        }

        // Transition: pending loaded → remove spinner, expose pending files immediately.
        // If historical mode, keep a secondary indicator so children show a history spinner.
        this.reposLoading.delete(normalizedRepoPath);
        if (!pendingOnly) {
          this.reposLoadingHistorical.add(normalizedRepoPath);
        }
        this._setFreshFiles(new Map(newFiles));
        this._onDidChangeTreeData.fire();

        if (pendingOnly) {
          continue;
        }

        // --- Phase 3: Historical changes (potentially slow) ---
        // Capture epoch so incremental callbacks from stale loads are silently dropped.
        const capturedEpoch = this.refreshEpoch;
        const onThresholdCrossed = (days: number, partial: Map<AbsolutePath, FileMetadata>) => {
          if (this.refreshEpoch !== capturedEpoch) { return; }

          // Update the historical cache incrementally so that a time-window switch
          // to any already-loaded window can be served instantly without re-running git.
          // Only upgrade — never overwrite a larger cached window with a smaller one.
          const existing = this.historicalCache.get(normalizedRepoPath);
          if (!existing || existing.maxDays < days) {
            const sortedByDate = Array.from(partial.entries()).sort((a, b) => a[1].date.getTime() - b[1].date.getTime());
            this.historicalCache.set(normalizedRepoPath, {
              data: partial,
              sortedByDate,
              maxDays: days,
              pathspec: this.repoPathspecs.get(normalizedRepoPath),
            });
          }

          // If the user switched to a smaller window while this load was in-flight,
          // filter the display to that window so we don't over-expose data.
          // If the current window is ≤ days we can serve it from the cache we just wrote.
          const currentDays = this.currentTimeWindow.type === "historical" ? this.currentTimeWindow.days : undefined;
          let displayPartial = partial;
          if (currentDays !== undefined && currentDays < days && this._canServeFromCache(currentDays)) {
            log(`Threshold ≤${days}d crossed but current window is ${currentDays}d — filtering display`);
            const cacheEntry = this.historicalCache.get(normalizedRepoPath);
            if (cacheEntry) {
              displayPartial = this.filterCacheToWindow(cacheEntry.sortedByDate, currentDays);
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
        if (repoError) {
          if (repoError.isPathspecError) {
            // The active pathspec caused git to fail. Clear it, warn the user, and
            // trigger a fresh reload so the tree is restored without the bad pathspec.
            const badPathspec = this.repoPathspecs.get(normalizedRepoPath);
            log(`Invalid pathspec "${badPathspec}" for ${normalizedRepoPath} — clearing and reloading`, "warn");
            this.repoPathspecs.delete(normalizedRepoPath);
            WorkspaceStateManager.setRepoPathspec(normalizedRepoPath, undefined);
            showWarning(
              `Invalid pathspec "${badPathspec}" was cleared. The tree will reload without it.`,
            );
            // Abort this load and start a fresh one without the bad pathspec.
            this.refresh();
            return;
          } else if (!errorToShow) {
            errorToShow = repoError.message;
          }
        }

        if (isCancelled()) {
          log("updateFreshFiles: cancelled after loading repo (newer refresh started)");
          return;
        }

        // Store the full maxDays result in the cache for instant future window switching.
        if (!repoError && fullData.size > 0) {
          const sortedByDate = Array.from(fullData.entries()).sort((a, b) => a[1].date.getTime() - b[1].date.getTime());
          this.historicalCache.set(normalizedRepoPath, {
            data: fullData,
            sortedByDate,
            maxDays,
            pathspec: this.repoPathspecs.get(normalizedRepoPath),
          });
          log(`Cached ${fullData.size} file(s) for ${normalizedRepoPath} (maxDays=${maxDays})`);
        }

        this.reposLoadingHistorical.delete(normalizedRepoPath);
        this._setFreshFiles(new Map(newFiles));
        this.historicalFiles = new Map(newHistoricalFiles);
        this._onDidChangeTreeData.fire();
      }
    }

    this.errorToShowInTreeView = errorToShow;
    this.dataLoaded = true;

    const totalRepos = this.workspaceFolders.reduce((sum, f) => sum + f.gitRepos.length, 0);
    log(
      `Loaded ${newFiles.size} total fresh file(s) across ${totalRepos} Git repository(ies)`,
    );

    ContextManager.setLoading(false);
    this.heatmapProvider?.fireDidChange();
  }

  // ---------------------------------------------------------------------------
  // Path index + per-render directory stats
  // ---------------------------------------------------------------------------

  /**
   * Replace freshFiles, rebuild the path index, and invalidate the stats cache.
   * All internal assignments to freshFiles must go through here.
   */
  private _setFreshFiles(map: Map<AbsolutePath, FileMetadata>): void {
    this._freshFiles = map;
    this._rebuildPathIndex();
  }

  /**
   * Build _pathIndex: normalized parent path → set of normalized direct child paths.
   * Files appear as leaves; intermediate directories are inferred.
   * Clearing _dirStatsCache is included so the next render pass recomputes stats.
   */
  private _rebuildPathIndex(): void {
    const index = new Map<string, Set<string>>();

    for (const filePath of this._freshFiles.keys()) {
      const normalized = filePath as string; // AbsolutePath is already forward-slash normalized

      // Register the file in its immediate parent directory.
      const fileSlash = normalized.lastIndexOf('/');
      if (fileSlash <= 0) { continue; }
      const immediateParent = normalized.substring(0, fileSlash);
      if (!index.has(immediateParent)) { index.set(immediateParent, new Set()); }
      index.get(immediateParent)!.add(normalized);

      // Walk up the directory chain, registering each dir in its parent.
      // Stop as soon as a dir is already present (all ancestors are already done).
      let child = immediateParent;
      while (true) {
        const sl = child.lastIndexOf('/');
        if (sl <= 0) { break; }
        const parent = child.substring(0, sl);
        if (!index.has(parent)) { index.set(parent, new Set()); }
        const parentSet = index.get(parent)!;
        if (parentSet.has(child)) { break; }
        parentSet.add(child);
        child = parent;
      }
    }

    this._pathIndex = index;
    this._dirStatsCache = null;
  }

  /**
   * Build (or return cached) per-render directory stats respecting current filters and scopes.
   * Single O(n) pass; each file propagates its stats up all ancestor directories.
   * Invalidated by _setFreshFiles() and refreshTreeOnly().
   */
  private _ensureDirStatsCache(): Map<string, { count: number; mostRecent: Date | undefined; linesAdded: number; linesDeleted: number }> {
    if (this._dirStatsCache) { return this._dirStatsCache; }

    const showLineChanges = ConfigService.getDescriptionFormat().showLineChanges;
    const cache = new Map<string, { count: number; mostRecent: Date | undefined; linesAdded: number; linesDeleted: number }>();

    for (const [filePath, metadata] of this._freshFiles) {
      if (!this.filterManager.passesFilters(metadata)) { continue; }
      const normalizedFile = normalizePath(filePath);
      if (!this.passesRepoScope(normalizedFile)) { continue; }

      // Propagate this file's contribution up every ancestor directory.
      let current = normalizedFile;
      while (true) {
        const sl = current.lastIndexOf('/');
        if (sl <= 0) { break; }
        const dir = current.substring(0, sl);
        let stats = cache.get(dir);
        if (!stats) {
          stats = { count: 0, mostRecent: undefined, linesAdded: 0, linesDeleted: 0 };
          cache.set(dir, stats);
        }
        stats.count++;
        if (!stats.mostRecent || metadata.date > stats.mostRecent) { stats.mostRecent = metadata.date; }
        if (showLineChanges) {
          stats.linesAdded += metadata.linesAdded ?? 0;
          stats.linesDeleted += metadata.linesDeleted ?? 0;
        }
        current = dir;
      }
    }

    this._dirStatsCache = cache;
    return cache;
  }

  // ---------------------------------------------------------------------------
  // Historical cache helpers
  // ---------------------------------------------------------------------------

  /** Returns true if every repo has a cached result that covers `days`. */
  private _canServeFromCache(days: number): boolean {
    for (const folder of this.workspaceFolders) {
      for (const repoRelPath of folder.gitRepos) {
        const repoFullPath = repoRelPath ? path.join(folder.path, repoRelPath) : folder.path;
        const normalizedRepoPath = normalizePath(repoFullPath);
        const cache = this.historicalCache.get(normalizedRepoPath);
        if (!cache) { return false; }
        if (cache.maxDays < days) { return false; }
        if (cache.pathspec !== this.repoPathspecs.get(normalizedRepoPath)) { return false; }
      }
    }
    return true;
  }

  /**
   * Filter cache entries to those modified within the last `days` days.
   * `sortedByDate` must be sorted ascending by date.
   * Binary searches for the cutoff, then copies the tail — O(log n + k).
   */
  private filterCacheToWindow(
    sortedByDate: ReadonlyArray<readonly [AbsolutePath, FileMetadata]>,
    days: number,
  ): Map<AbsolutePath, FileMetadata> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    // Find the leftmost index where date >= cutoff (lower bound).
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
   * Rebuild freshFiles and historicalFiles from the historical cache, filtered to `days`.
   * Preserves any pending (uncommitted) entries currently in freshFiles.
   */
  private _applyHistoricalCacheToWindow(days: number): void {
    const newHistorical = new Map<AbsolutePath, FileMetadata>();

    for (const folder of this.workspaceFolders) {
      for (const repoRelPath of folder.gitRepos) {
        const repoFullPath = repoRelPath ? path.join(folder.path, repoRelPath) : folder.path;
        const normalizedRepoPath = normalizePath(repoFullPath);
        const cache = this.historicalCache.get(normalizedRepoPath);
        if (!cache) { continue; }
        const filtered = this.filterCacheToWindow(cache.sortedByDate, days);
        for (const [absPath, metadata] of filtered) {
          newHistorical.set(absPath, metadata);
        }
      }
    }

    // Start fresh files from historical, then overlay pending entries (pending wins).
    const newFresh = new Map<AbsolutePath, FileMetadata>(newHistorical);
    for (const [absPath, metadata] of this.freshFiles) {
      if (metadata.isPending) {
        newFresh.set(absPath, metadata);
      }
    }

    this.historicalFiles = newHistorical;
    this._setFreshFiles(newFresh);
  }

  /**
   * Switch to pending-only display using entries already present in freshFiles.
   * In pending mode historicalFiles is empty (refreshPending will re-overlay if needed).
   */
  private _applyPendingOnlyFromExisting(): void {
    const pendingOnly = new Map<AbsolutePath, FileMetadata>();
    for (const [absPath, metadata] of this.freshFiles) {
      if (metadata.isPending) {
        pendingOnly.set(absPath, metadata);
      }
    }
    this.historicalFiles = new Map();
    this._setFreshFiles(pendingOnly);
  }

  /**
   * Return cache memory stats for each known repository.
   * Uses v8.serialize for accurate byte measurement — call on demand only (not on every load).
   */
  getCacheStats(): CacheRepoStats[] {
    const stats: CacheRepoStats[] = [];
    for (const folder of this.workspaceFolders) {
      for (const repoRelPath of folder.gitRepos) {
        const repoFullPath = repoRelPath ? path.join(folder.path, repoRelPath) : folder.path;
        const normalizedRepoPath = normalizePath(repoFullPath);
        const repoLabel = repoRelPath || folder.name;
        const cache = this.historicalCache.get(normalizedRepoPath);
        if (cache) {
          const sizeBytes = v8.serialize(cache.data).byteLength;
          stats.push({ repoLabel, repoPath: repoFullPath, entryCount: cache.data.size, sizeBytes });
        } else {
          stats.push({ repoLabel, repoPath: repoFullPath, entryCount: 0, sizeBytes: 0 });
        }
      }
    }
    return stats;
  }

  private countFilesInDirectory(dirPath: string): number {
    return this._ensureDirStatsCache().get(normalizePath(dirPath))?.count ?? 0;
  }

  getMostRecentDateInDirectory(dirPath: string): Date | undefined {
    return this._ensureDirStatsCache().get(normalizePath(dirPath))?.mostRecent;
  }

  private buildTree(parentPath: string): FreshFileItem[] {
    const normalizedParent = normalizePath(parentPath);
    // const t0 = performance.now();

    const directChildren = this._pathIndex.get(normalizedParent);
    if (!directChildren || directChildren.size === 0) { return []; }

    // Build the dir stats cache once (shared across all buildTree calls this render pass).
    const dirStats = this._ensureDirStatsCache();
    const descriptionFormat = ConfigService.getDescriptionFormat();
    const autoExpandDepth = ConfigService.getAutoExpandDepth();

    const items: FreshFileItem[] = [];

    for (const childPath of directChildren) {
      const isFile = this._freshFiles.has(childPath as AbsolutePath);
      const name = childPath.substring(normalizedParent.length + 1);
      const fullPath = path.join(parentPath, name);
      const uri = vscode.Uri.file(fullPath);

      if (isFile) {
        const metadata = this._freshFiles.get(childPath as AbsolutePath)!;
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

    // Sort based on current sort order
    FreshFileItemSorter.sort(
      items,
      this.sortOrder,
      (item) => item.isDirectory
        ? dirStats.get(normalizePath(item.resourceUri.fsPath))?.mostRecent
        : this._freshFiles.get(asAbsolutePath(item.resourceUri.fsPath))?.date,
      (item) => item.isDirectory
        ? ""
        : (this._freshFiles.get(asAbsolutePath(item.resourceUri.fsPath))?.author || ""),
    );

    // this.perfDebug(t0, directChildren, parentPath, items);

    return items;
  }

  private perfDebug(t0: number, directChildren: Set<string>, parentPath: string, items: FreshFileItem[]) {
    const elapsed = performance.now() - t0;
    this._renderPass.calls++;
    this._renderPass.totalMs += elapsed;
    this._renderPass.totalScanned += directChildren.size;

    const dirName = path.basename(parentPath);
    log(`buildTree [${dirName}]: ${elapsed.toFixed(1)}ms, ${directChildren.size} children → ${items.length} items | cumulative: ${this._renderPass.calls} calls, ${this._renderPass.totalMs.toFixed(1)}ms`);
  }
}
