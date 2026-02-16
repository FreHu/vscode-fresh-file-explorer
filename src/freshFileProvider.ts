import * as vscode from "vscode";
import * as path from "path";

import { ConfigService } from "./config/configService";
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
} from "./types";
import { buildTimeWindows, isPendingChangesMode, TimeWindow } from "./timeWindowUtils";
import { AbsolutePath, asAbsolutePath } from "./pathTypes";
import { formatFileDescription, formatFileTooltip, formatDirectoryTooltip, formatRelativeDate } from "./utils/formatUtils";
import { log } from "./utils/logger";
import { FreshFileItem, MessageTreeItem as MessageTreeItem, FreshFilesTreeItem, NoteTreeItem } from "./treeItems";
import { normalizePath } from "./utils";
import { GroupingMode, DEFAULT_GROUPING_MODE } from "./groupingMode";
import { type MoonPhase } from "./utils/moonPhase";
import { clearRetrogradeCache } from "./utils/planetaryRetrograde";
import { TreeItemContextValues, createPinnedFileId } from "./treeItemConstants";
import { PinnedItemsManager } from "./pinnedItemsManager";
import { FilterManager } from "./filterManager";
import { GroupingViewBuilder } from "./groupingViewBuilder";
import { DataCollector } from "./dataCollector";

export class FreshFileProvider implements vscode.TreeDataProvider<FreshFilesTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<FreshFilesTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // Map of absolute file path to file metadata
  freshFiles: Map<AbsolutePath, FileMetadata> = new Map();
  currentTimeWindow: TimeWindow;
  timeWindows: TimeWindow[];
  // Multi-root workspace support
  workspaceFolders: WorkspaceFolderInfo[] = [];
  private errorToShowInTreeView: string | undefined;
  private context: vscode.ExtensionContext | undefined;
  private refreshPromise: Promise<void> | undefined;
  private dataLoaded: boolean = false;

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

  constructor() {
    this.initializeWorkspaceFolders();
    this.timeWindows = this.loadTimeWindows();
    this.currentTimeWindow = this.timeWindows[0]; // Will be overridden by persisted value

    // Set initial context - we're loading
    vscode.commands.executeCommand("setContext", "freshFileExplorer.loading", true);
    vscode.commands.executeCommand("setContext", "freshFileExplorer.hasRepos", false);

    if (this.workspaceFolders.length === 0) {
      log(`FreshFileProvider initialized with no workspace folders`);
    } else if (this.workspaceFolders.length === 1) {
      log(`FreshFileProvider initialized with workspace: ${this.workspaceFolders[0].name}`);
    } else {
      log(
        `FreshFileProvider initialized with ${this.workspaceFolders.length} workspace folders: ${this.workspaceFolders
          .map(f => f.name)
          .join(", ")}`,
      );
    }
  }

  initializeWorkspaceFolders(): void {
    const folders = vscode.workspace.workspaceFolders || [];
    this.workspaceFolders = folders.map(folder => ({
      path: asAbsolutePath(folder.uri.fsPath),
      name: folder.name,
      gitRepos: [],
    }));
  }

  /**
   * Initialize with extension context for state persistence
   */
  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
    
    // Initialize managers
    this.pinnedItemsManager.initialize(context, () => this.refreshTreeOnly());
    this.filterManager.initialize(() => this.refreshTreeOnly());
    
    // Load persisted time window selection
    const persistedDays = context.workspaceState.get<number>("selectedTimeWindowDays");
    this.openChangesMode = context.workspaceState.get<boolean>("openChangesMode", false);
    this.groupingMode = context.workspaceState.get<GroupingMode>("groupingMode", DEFAULT_GROUPING_MODE);
    this.sortOrder = context.workspaceState.get<SortOrder>("sortOrder", "name");
    // Set initial context for when clause
    vscode.commands.executeCommand("setContext", "freshFileExplorer.openChangesMode", this.openChangesMode);

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
    log("Configuration changed, refreshing");
    // Reload time windows in case they changed
    this.timeWindows = this.loadTimeWindows();
    // Verify current selection is still valid
    const currentStillValid = this.timeWindows.find(tw => {
      if (tw.type === "pending" && this.currentTimeWindow.type === "pending") {
        return true;
      }
      return (
        tw.type === "historical" &&
        this.currentTimeWindow.type === "historical" &&
        tw.days === this.currentTimeWindow.days
      );
    });
    if (!currentStillValid) {
      this.currentTimeWindow = this.timeWindows.length > 1 ? this.timeWindows[1] : this.timeWindows[0];
    }
    this._onDidChangeTreeData.fire();
  }

  refresh(): void {
    const daysText = this.currentTimeWindow.type === "historical" ? ` (${this.currentTimeWindow.days} days)` : "";
    log(`Refreshing tree view with time window: ${this.currentTimeWindow.label}${daysText}`);
    vscode.commands.executeCommand("setContext", "freshFileExplorer.loading", true);
    this.dataLoaded = false;
    this.freshFiles = new Map();
    clearRetrogradeCache();
    this._onDidChangeTreeData.fire();
  }

  /** Refresh the tree display without reloading data from git */
  refreshTreeOnly(): void {
    this._onDidChangeTreeData.fire();
  }

  setTimeWindow(timeWindow: TimeWindow): void {
    log(`Time window changed from ${this.currentTimeWindow.label} to ${timeWindow.label}`);
    this.currentTimeWindow = timeWindow;
    this.filterManager.clearFilters();
    if (this.context && timeWindow.type === "historical") {
      this.context.workspaceState.update("selectedTimeWindowDays", timeWindow.days);
    }
    this.refresh();
  }

  toggleOpenMode(): void {
    this.openChangesMode = !this.openChangesMode;
    log(`Toggled open mode: ${this.openChangesMode ? "changes" : "file"}`);

    if (this.context) {
      this.context.workspaceState.update("openChangesMode", this.openChangesMode);
    }

    vscode.commands.executeCommand("setContext", "freshFileExplorer.openChangesMode", this.openChangesMode);

    this.refreshTreeOnly();
  }

  setTreeView(treeView: vscode.TreeView<FreshFilesTreeItem>): void {
    this.treeView = treeView;
    this.updateGroupingModeMessage();
  }

  setGroupingMode(mode: GroupingMode): void {
    log(`Grouping mode changed from ${this.groupingMode} to ${mode}`);
    this.groupingMode = mode;

    if (this.context) {
      this.context.workspaceState.update("groupingMode", mode);
    }

    this.updateGroupingModeMessage();

    this.refreshTreeOnly();
  }

  setSortOrder(order: SortOrder): void {
    log(`Sort order changed from ${this.sortOrder} to ${order}`);
    this.sortOrder = order;

    if (this.context) {
      this.context.workspaceState.update("sortOrder", order);
    }

    this.refreshTreeOnly();
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

  /** Find which workspace folder contains a given absolute file path */
  findWorkspaceFolderForPath(absolutePath: AbsolutePath): WorkspaceFolderInfo | undefined {
    // Normalize path separators
    const normalizedPath = normalizePath(absolutePath);

    // Find the workspace folder that contains this path
    for (const folder of this.workspaceFolders) {
      const normalizedFolder = normalizePath(folder.path);
      if (normalizedPath === normalizedFolder || normalizedPath.startsWith(normalizedFolder + "/")) {
        return folder;
      }
    }
    return undefined;
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
  setSyncWarnings(warnings: string[]): void {
    this.syncWarnings = warnings;
    this.refreshTreeOnly();
  }
  
  /** Set repository branch names from git extension */
  setRepoBranches(branches: Map<string, BranchName>): void {
    this.repoBranches = branches;
    this.refreshTreeOnly();
  }

  getTreeItem(element: FreshFilesTreeItem): vscode.TreeItem {
    return element;
  }

  getParent(element: FreshFilesTreeItem): FreshFilesTreeItem | undefined {
    if (!(element instanceof FreshFileItem)) {
      return undefined;
    }

    // Find which workspace folder this element belongs to
    const folder = this.findWorkspaceFolderForPath(asAbsolutePath(element.resourceUri.fsPath));
    if (!folder) {
      return undefined;
    }

    const filePath = normalizePath(path.relative(folder.path, element.resourceUri.fsPath));
    const lastSlash = filePath.lastIndexOf("/");

    if (lastSlash === -1) {
      // Item is at root level of this workspace folder, no parent
      return undefined;
    }

    // Get parent directory path
    const parentPath = filePath.substring(0, lastSlash);
    const parentUri = vscode.Uri.file(path.join(folder.path, parentPath));

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

      // Populate fresh files if not already done
      // Use promise cache to prevent concurrent updates
      if (!this.dataLoaded) {
        if (!this.refreshPromise) {
          log("Loading files from Git repositories...");
          this.refreshPromise = this.updateFreshFiles().finally(() => {
            this.refreshPromise = undefined;
          });
        }
        await this.refreshPromise;
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

      // Check if no files found
      if (this.freshFiles.size === 0) {
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

    // Get children of pinned folder
    if (element instanceof FreshFileItem && element.contextValue === TreeItemContextValues.PINNED_FOLDER) {
      return this.buildPinnedItems();
    }

    // Get children of an author group
    if (element instanceof FreshFileItem && element.contextValue === TreeItemContextValues.AUTHOR_GROUP) {
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

    // Get children of a commit hash group
    if (element instanceof FreshFileItem && element.contextValue === TreeItemContextValues.COMMIT_HASH_GROUP) {
      const commitHash = element.label as string;
      return GroupingViewBuilder.buildCommitHashFiles(
        commitHash,
        this.freshFiles,
        (metadata) => this.filterManager.passesFilters(metadata),
        this.sortOrder,
        this.openChangesMode,
      );
    }

    // Get children of a moon phase group
    if (element instanceof FreshFileItem && element.contextValue === TreeItemContextValues.MOON_PHASE_GROUP) {
      const moonPhaseName = decodeURIComponent(element.resourceUri.path.replace("/", ""));
      return GroupingViewBuilder.buildMoonPhaseFiles(
        moonPhaseName as MoonPhase,
        this.freshFiles,
        (metadata) => this.filterManager.passesFilters(metadata),
        this.sortOrder,
        this.openChangesMode,
      );
    }

    // Get children of a retrograde group
    if (element instanceof FreshFileItem && element.contextValue === TreeItemContextValues.RETROGRADE_GROUP) {
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
      return this.buildTree(element.resourceUri.fsPath);
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

        const filesInRepo = Array.from(this.freshFiles.keys()).filter(filePath => {
          const normalized = normalizePath(filePath);
          // File must be in this repo
          if (normalized !== repoNormalized && !normalized.startsWith(repoNormalized + "/")) {
            return false;
          }

          return true;
        });

        const fileCount = filesInRepo.length;

        const repoUri = vscode.Uri.file(repoPath);
        const branchName = this.repoBranches.get(repoNormalized);

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
        const folder = this.findWorkspaceFolderForPath(filePath);
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

    const result = await DataCollector.collectAllFiles(this.workspaceFolders, this.currentTimeWindow);
    
    this.freshFiles = result.files;
    this.errorToShowInTreeView = result.error;
    this.dataLoaded = true;

    // Notify heatmap decoration provider of data changes
    this.heatmapProvider?.fireDidChange();
  }

  private countFilesInDirectory(dirPath: string): number {
    let count = 0;
    const normalizedDir = normalizePath(dirPath);
    const prefix = normalizedDir + "/";

    for (const [filePath, metadata] of this.freshFiles) {
      const normalizedFile = normalizePath(filePath);
      if (normalizedFile.startsWith(prefix)) {
        if (this.filterManager.passesFilters(metadata)) {
          count++;
        }
      }
    }

    return count;
  }

  getMostRecentDateInDirectory(dirPath: string): Date | undefined {
    let mostRecent: Date | undefined;
    const normalizedDir = normalizePath(dirPath);
    const prefix = normalizedDir + "/";

    for (const [filePath, metadata] of this.freshFiles) {
      const normalizedFile = normalizePath(filePath);
      if (normalizedFile.startsWith(prefix)) {
        if (this.filterManager.passesFilters(metadata)) {
          if (!mostRecent || metadata.date > mostRecent) {
            mostRecent = metadata.date;
          }
        }
      }
    }

    return mostRecent;
  }

  private buildTree(parentPath: string): FreshFileItem[] {
    // parentPath is now an absolute path (workspace folder path or subdirectory)
    // Normalize to forward slashes for consistent matching
    const normalizedParent = normalizePath(parentPath);

    const children = new Map<string, { isDirectory: boolean; hasChildren: boolean }>();

    // Find all items that should appear under this parent (respecting filters)
    for (const [filePath, metadata] of this.freshFiles) {
      // Apply filters - skip files matching excluded authors or commits
      if (!this.filterManager.passesFilters(metadata)) {
        continue;
      }

      const normalizedFile = normalizePath(filePath);

      // Check if file is under this parent
      if (normalizedFile === normalizedParent || normalizedFile.startsWith(normalizedParent + "/")) {
        // Calculate relative path from parent
        const relativePath =
          normalizedFile === normalizedParent ? "" : normalizedFile.substring(normalizedParent.length + 1);

        if (relativePath.length === 0) {
          // Human note: This branch is likely useless
          // AI Note: Edge case: buildTree was called with a file path from freshFiles.
          // This means we're trying to show a file as its own child, which doesn't make sense.
          // Skip it - directories in the tree are virtual groupings, not entries in freshFiles.
          continue;
        }

        const nextSlash = relativePath.indexOf("/");

        if (nextSlash === -1) {
          // Direct child file
          children.set(relativePath, { isDirectory: false, hasChildren: false });
        } else {
          // Subdirectory
          const dirName = relativePath.substring(0, nextSlash);
          children.set(dirName, { isDirectory: true, hasChildren: true });
        }
      }
    }

    // Convert to tree items
    const items: FreshFileItem[] = [];
    for (const [name, info] of children.entries()) {
      // Build full path
      const fullPath = path.join(parentPath, name);
      const uri = vscode.Uri.file(fullPath);

      // Determine collapsible state based on auto-expand depth
      // Count depth relative to workspace folder
      const folder = this.findWorkspaceFolderForPath(asAbsolutePath(fullPath));
      const folderDepth = folder ? folder.path.split(/[\/\\]/).filter((s: string) => s.length > 0).length : 0;
      const itemDepth = fullPath.split(/[/\\]/).filter(s => s.length > 0).length;
      const relativeDepth = itemDepth - folderDepth;

      let collapsibleState = vscode.TreeItemCollapsibleState.None;
      if (info.isDirectory) {
        collapsibleState =
          relativeDepth < ConfigService.getAutoExpandDepth()
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed;
      }

      // Calculate file count for directories
      const fileCount = info.isDirectory ? this.countFilesInDirectory(fullPath) : undefined;

      // Get file metadata for deleted status and commit hash
      // Note: Only files can be deleted, directories are virtual groupings
      const normalizedFullPath = asAbsolutePath(fullPath);
      const fileMetadata = this.freshFiles.get(normalizedFullPath);
      const isDeleted = !info.isDirectory && (fileMetadata?.isDeleted ?? false);
      const commitHash = fileMetadata?.commitHash;
      const isPending = !info.isDirectory && (fileMetadata?.isPending ?? false);
      const status = fileMetadata?.status;

      const item = info.isDirectory
        ? FreshFileItem.forDirectory(
            uri,
            this.openChangesMode,
            fileCount!,
            collapsibleState === vscode.TreeItemCollapsibleState.Expanded,
          )
        : FreshFileItem.forFile(uri, this.openChangesMode, isDeleted, commitHash, isPending, status);

      // Add tooltip and description
      if (info.isDirectory) {
        const mostRecent = this.getMostRecentDateInDirectory(fullPath);
        if (mostRecent) {
          item.tooltip = formatDirectoryTooltip(fileCount!, mostRecent);
        }
      } else if (fileMetadata) {
        // Set description (shown next to filename)
        item.description = formatFileDescription(fileMetadata, ConfigService.getDescriptionFormat());
        item.tooltip = formatFileTooltip(fileMetadata);
      }

      items.push(item);
    }

    // Sort based on current sort order
    items.sort((a, b) => {
      // For date sorting, don't separate directories and files
      // For other sorts, directories come first
      if (this.sortOrder !== "date" && a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }

      switch (this.sortOrder) {
        case "date": {
          // Get dates for comparison
          const dateA = a.isDirectory
            ? this.getMostRecentDateInDirectory(a.resourceUri.fsPath)
            : this.freshFiles.get(asAbsolutePath(a.resourceUri.fsPath))?.date;
          const dateB = b.isDirectory
            ? this.getMostRecentDateInDirectory(b.resourceUri.fsPath)
            : this.freshFiles.get(asAbsolutePath(b.resourceUri.fsPath))?.date;

          if (!dateA && !dateB) {
            return 0;
          }
          if (!dateA) {
            return 1; // Items without dates go to the end
          }
          if (!dateB) {
            return -1;
          }

          // Sort by date descending (newest first)
          const dateDiff = dateB.getTime() - dateA.getTime();
          if (dateDiff !== 0) {
            return dateDiff;
          }

          // Tiebreaker: alphabetical by filename
          return path.basename(a.resourceUri.fsPath).localeCompare(path.basename(b.resourceUri.fsPath));
        }
        
        case "author": {
          // Get authors for comparison
          const authorA = a.isDirectory
            ? "" // Directories don't have authors, will be sorted first
            : (this.freshFiles.get(asAbsolutePath(a.resourceUri.fsPath))?.author || "");
          const authorB = b.isDirectory
            ? ""
            : (this.freshFiles.get(asAbsolutePath(b.resourceUri.fsPath))?.author || "");

          const authorCompare = authorA.localeCompare(authorB);
          if (authorCompare !== 0) {
            return authorCompare;
          }

          // Tiebreaker: alphabetical by filename
          return path.basename(a.resourceUri.fsPath).localeCompare(path.basename(b.resourceUri.fsPath));
        }
        
        case "name":
        default:
          // Alphabetical by filename (directories already sorted first above)
          return path.basename(a.resourceUri.fsPath).localeCompare(path.basename(b.resourceUri.fsPath));
      }
    });

    return items;
  }
}
