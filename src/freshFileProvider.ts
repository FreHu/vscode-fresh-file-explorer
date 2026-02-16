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
  PinnedItem,
  SortOrder,
} from "./types";
import { buildTimeWindows, isPendingChangesMode, TimeWindow } from "./timeWindowUtils";
import { AbsolutePath, asAbsolutePath } from "./pathTypes";
import { formatFileDescription, formatFileTooltip, formatDirectoryTooltip, formatRelativeDate } from "./utils/formatUtils";
import { log } from "./utils/logger";
import { FreshFileItem, MessageTreeItem as MessageTreeItem, FreshFilesTreeItem, NoteTreeItem } from "./treeItems";
import { normalizePath } from "./utils";
import { GroupingMode, DEFAULT_GROUPING_MODE } from "./groupingMode";
import { getMoonPhase, type MoonPhase } from "./utils/moonPhase";
import { getRetrogradeInfo, getRetrogradeKey, clearRetrogradeCache, type Planet } from "./utils/planetaryRetrograde";
import {
  collectHistoricalChanges,
  collectPendingChanges,
  discoverGitReposInSubdirs,
  isGitRepository,
} from "./git/gitOperations";
import { TreeItemContextValues, createPinnedFileId, normalizeItemId, getItemIdWithNormalizedPath } from "./treeItemConstants";

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

  // Filters - not persisted, reset when time window changes
  excludedAuthors: Set<string> = new Set();
  excludedCommits: Set<CommitHash> = new Set();

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

  // Pinned items (notes and files) - persisted per workspace, ordered
  private pinnedItems: PinnedItem[] = [];

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
    // Load persisted time window selection
    const persistedDays = context.workspaceState.get<number>("selectedTimeWindowDays");
    this.openChangesMode = context.workspaceState.get<boolean>("openChangesMode", false);
    this.groupingMode = context.workspaceState.get<GroupingMode>("groupingMode", DEFAULT_GROUPING_MODE);
    this.sortOrder = context.workspaceState.get<SortOrder>("sortOrder", "name");
    // Load persisted pinned items
    const persistedItems = context.workspaceState.get<PinnedItem[]>("pinnedItems", []);
    this.pinnedItems = persistedItems;
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
    // Set loading state
    vscode.commands.executeCommand("setContext", "freshFileExplorer.loading", true);
    // Clear the data loaded flag to force a reload
    this.dataLoaded = false;
    // Clear the file map
    this.freshFiles = new Map();
    // Clear astronomical calculation cache
    clearRetrogradeCache();
    // Fire the tree change event which will trigger getChildren() to reload
    this._onDidChangeTreeData.fire();
  }

  /** Refresh the tree display without reloading data from git */
  refreshTreeOnly(): void {
    this._onDidChangeTreeData.fire();
  }

  setTimeWindow(timeWindow: TimeWindow): void {
    log(`Time window changed from ${this.currentTimeWindow.label} to ${timeWindow.label}`);
    this.currentTimeWindow = timeWindow;
    // Clear filters when time window changes (authors/commits may be different)
    this.excludedAuthors.clear();
    this.excludedCommits.clear();
    // Persist the selection (only meaningful for historical windows)
    if (this.context && timeWindow.type === "historical") {
      this.context.workspaceState.update("selectedTimeWindowDays", timeWindow.days);
    }
    this.refresh();
  }

  toggleOpenMode(): void {
    this.openChangesMode = !this.openChangesMode;
    log(`Toggled open mode: ${this.openChangesMode ? "changes" : "file"}`);

    // Persist the toggle state
    if (this.context) {
      this.context.workspaceState.update("openChangesMode", this.openChangesMode);
    }

    // Update the context for when clause in package.json
    vscode.commands.executeCommand("setContext", "freshFileExplorer.openChangesMode", this.openChangesMode);

    // Refresh tree items without reloading data (just update the commands)
    this.refreshTreeOnly();
  }

  setTreeView(treeView: vscode.TreeView<FreshFilesTreeItem>): void {
    this.treeView = treeView;
    // Apply message for persisted grouping mode
    this.updateGroupingModeMessage();
  }

  setGroupingMode(mode: GroupingMode): void {
    log(`Grouping mode changed from ${this.groupingMode} to ${mode}`);
    this.groupingMode = mode;

    // Persist the selection
    if (this.context) {
      this.context.workspaceState.update("groupingMode", mode);
    }

    this.updateGroupingModeMessage();

    // Refresh tree items without reloading data
    this.refreshTreeOnly();
  }

  setSortOrder(order: SortOrder): void {
    log(`Sort order changed from ${this.sortOrder} to ${order}`);
    this.sortOrder = order;

    // Persist the selection
    if (this.context) {
      this.context.workspaceState.update("sortOrder", order);
    }

    // Refresh tree items without reloading data
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
    this.excludedAuthors = authors;
    log(`Filter: excluding ${authors.size} author(s): ${Array.from(authors).join(", ")}`);
    this.refreshTreeOnly();
  }

  /** Set excluded commits (files from these commits will be hidden) */
  setExcludedCommits(commits: Set<CommitHash>): void {
    this.excludedCommits = commits;
    log(`Filter: excluding ${commits.size} commit(s): ${Array.from(commits).join(", ")}`);
    this.refreshTreeOnly();
  }

  /** Clear all filters */
  clearFilters(): void {
    this.excludedAuthors.clear();
    this.excludedCommits.clear();
    log("Filters cleared");
    this.refreshTreeOnly();
  }

  /** Check if any filters are active */
  hasActiveFilters(): boolean {
    return this.excludedAuthors.size > 0 || this.excludedCommits.size > 0;
  }

  /** Get current filter summary for display */
  getFilterSummary(): string {
    const parts: string[] = [];
    if (this.excludedAuthors.size > 0) {
      parts.push(`${this.excludedAuthors.size} author(s) hidden`);
    }
    if (this.excludedCommits.size > 0) {
      parts.push(`${this.excludedCommits.size} commit(s) hidden`);
    }
    return parts.join(", ");
  }

  /** Add file(s) to pinned items */
  pinFiles(filePaths: AbsolutePath[]): void {
    for (const filePath of filePaths) {
      // Check if not already pinned
      if (!this.pinnedItems.some(item => item.type === "file" && item.id === filePath)) {
        this.pinnedItems.push({ type: "file", id: filePath, data: "" });
      }
    }
    this.persistPinnedItems();
    log(`Pinned ${filePaths.length} file(s)`);
    this.refreshTreeOnly();
  }

  /** Remove file(s) from pinned items */
  unpinFiles(filePaths: AbsolutePath[]): void {
    this.pinnedItems = this.pinnedItems.filter(
      item => !(item.type === "file" && filePaths.includes(item.id as AbsolutePath))
    );
    this.persistPinnedItems();
    log(`Unpinned ${filePaths.length} file(s)`);
    this.refreshTreeOnly();
  }

  /** Check if a file is pinned */
  isPinned(filePath: AbsolutePath): boolean {
    return this.pinnedItems.some(item => item.type === "file" && item.id === filePath);
  }

  /** Get all pinned files */
  getPinnedFiles(): AbsolutePath[] {
    return this.pinnedItems
      .filter(item => item.type === "file")
      .map(item => item.id as AbsolutePath);
  }

  /** Add a note to pinned items */
  addNote(noteText: string): void {
    const noteId = Date.now().toString();
    this.pinnedItems.push({ type: "note", id: noteId, data: noteText });
    this.persistPinnedItems();
    log(`Added note: ${noteText}`);
    this.refreshTreeOnly();
  }

  /** Remove a note from pinned items */
  removeNote(noteId: string): void {
    this.pinnedItems = this.pinnedItems.filter(
      item => !(item.type === "note" && item.id === noteId)
    );
    this.persistPinnedItems();
    log(`Removed note: ${noteId}`);
    this.refreshTreeOnly();
  }

  /** Update a note's text */
  updateNote(noteId: string, noteText: string): void {
    const item = this.pinnedItems.find(item => item.type === "note" && item.id === noteId);
    if (item) {
      item.data = noteText;
      this.persistPinnedItems();
      log(`Updated note: ${noteId}`);
      this.refreshTreeOnly();
    }
  }

  /** Toggle a note's completed state (for todo-style notes) */
  toggleNoteCompleted(noteId: string): void {
    const item = this.pinnedItems.find(item => item.type === "note" && item.id === noteId);
    if (item) {
      item.completed = !(item.completed ?? false);
      this.persistPinnedItems();
      log(`Note ${noteId} completed: ${item.completed}`);
      this.refreshTreeOnly();
    }
  }

  /** Clear all pinned items (files and notes) */
  clearAllPinned(): void {
    this.pinnedItems = [];
    this.persistPinnedItems();
    log("Cleared all pinned items");
    this.refreshTreeOnly();
  }

  /** Clear only completed notes */
  clearCompleted(): void {
    this.pinnedItems = this.pinnedItems.filter(
      item => item.type !== "note" || !item.completed
    );
    this.persistPinnedItems();
    log("Cleared completed notes");
    this.refreshTreeOnly();
  }

  /** Reorder pinned items */
  reorderPinnedItems(sourceId: string, targetId: string, dropBefore: boolean): void {
    log(`reorderPinnedItems called: sourceId=${sourceId}, targetId=${targetId}, dropBefore=${dropBefore}`);
    
    // Normalize sourceId and targetId for comparison (handle path separators)
    const normalizedSourceId = normalizeItemId(sourceId, normalizePath);
    const normalizedTargetId = normalizeItemId(targetId, normalizePath);
    
    const sourceIndex = this.pinnedItems.findIndex(item => {
      return getItemIdWithNormalizedPath(item, normalizePath) === normalizedSourceId;
    });
    const targetIndex = this.pinnedItems.findIndex(item => {
      return getItemIdWithNormalizedPath(item, normalizePath) === normalizedTargetId;
    });

    log(`reorderPinnedItems: sourceIndex=${sourceIndex}, targetIndex=${targetIndex}`);
    log(`reorderPinnedItems: pinnedItems count=${this.pinnedItems.length}`);
    log(`reorderPinnedItems: pinnedItems IDs=${this.pinnedItems.map(item => 
      item.type === "note" ? `note:${item.id}` : `pinned:${item.id}`
    ).join(", ")}`);

    if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) {
      log(`reorderPinnedItems: Aborting - invalid indices or same position`);
      return;
    }

    const [movedItem] = this.pinnedItems.splice(sourceIndex, 1);
    const newTargetIndex = sourceIndex < targetIndex ? targetIndex : targetIndex;
    const insertIndex = dropBefore ? newTargetIndex : newTargetIndex + 1;
    this.pinnedItems.splice(insertIndex, 0, movedItem);

    this.persistPinnedItems();
    log(`Reordered pinned item from index ${sourceIndex} to ${insertIndex}`);
    this.refreshTreeOnly();
  }

  /** Move a pinned item to the first position */
  movePinnedItemToFirst(sourceId: string): void {
    log(`movePinnedItemToFirst called: sourceId=${sourceId}`);
    
    // Normalize sourceId for comparison
    const normalizedSourceId = normalizeItemId(sourceId, normalizePath);
    
    const sourceIndex = this.pinnedItems.findIndex(item => {
      return getItemIdWithNormalizedPath(item, normalizePath) === normalizedSourceId;
    });

    log(`movePinnedItemToFirst: sourceIndex=${sourceIndex}`);

    if (sourceIndex === -1 || sourceIndex === 0) {
      log(`movePinnedItemToFirst: Aborting - item not found or already at first position`);
      return;
    }

    const [movedItem] = this.pinnedItems.splice(sourceIndex, 1);
    this.pinnedItems.unshift(movedItem);

    this.persistPinnedItems();
    log(`Moved pinned item from index ${sourceIndex} to first position`);
    this.refreshTreeOnly();
  }

  /** Pin files at a specific position (0 = first) */
  pinFilesAtPosition(filePaths: AbsolutePath[], position: number): void {
    log(`pinFilesAtPosition: Adding ${filePaths.length} file(s) at position ${position}`);
    
    const alreadyPinned: AbsolutePath[] = [];
    const newFiles: AbsolutePath[] = [];
    
    for (const path of filePaths) {
      if (this.pinnedItems.some(item => item.type === "file" && normalizePath(item.id) === normalizePath(path))) {
        alreadyPinned.push(path);
      } else {
        newFiles.push(path);
      }
    }
    
    // First, insert new files at the position
    if (newFiles.length > 0) {
      const newItems: PinnedItem[] = newFiles.map(path => ({ type: "file" as const, id: path, data: "" }));
      this.pinnedItems.splice(position, 0, ...newItems);
      log(`pinFilesAtPosition: Added ${newItems.length} new file(s)`);
    }
    
    // Then, reorder already-pinned files to follow
    if (alreadyPinned.length > 0) {
      let targetIndex = position + newFiles.length;
      for (const path of alreadyPinned) {
        const pinnedId = `pinned:${normalizePath(path)}`;
        const currentIndex = this.pinnedItems.findIndex(item => 
          item.type === "file" && `pinned:${normalizePath(item.id)}` === pinnedId
        );
        if (currentIndex !== -1 && currentIndex !== targetIndex) {
          const [item] = this.pinnedItems.splice(currentIndex, 1);
          // Adjust target if we removed from before it
          if (currentIndex < targetIndex) {targetIndex--;}
          this.pinnedItems.splice(targetIndex, 0, item);
          targetIndex++;
        }
      }
      log(`pinFilesAtPosition: Reordered ${alreadyPinned.length} already-pinned file(s)`);
    }
    
    log(`pinFilesAtPosition: Total pinnedItems=${this.pinnedItems.length}`);
    
    this.persistPinnedItems();
    this.refreshTreeOnly();
  }

  /** Pin files after a specific item */
  pinFilesAfterItem(filePaths: AbsolutePath[], afterItemId: string): void {
    const normalizedAfterId = normalizeItemId(afterItemId, normalizePath);
    
    log(`pinFilesAfterItem: Adding ${filePaths.length} file(s) after item ${normalizedAfterId}`);
    
    const afterIndex = this.pinnedItems.findIndex(item => {
      return getItemIdWithNormalizedPath(item, normalizePath) === normalizedAfterId;
    });
    
    if (afterIndex === -1) {
      log(`pinFilesAfterItem: Target item not found, falling back to append`);
      this.pinFiles(filePaths);
      return;
    }
    
    const alreadyPinned: AbsolutePath[] = [];
    const newFiles: AbsolutePath[] = [];
    
    for (const path of filePaths) {
      if (this.pinnedItems.some(item => item.type === "file" && normalizePath(item.id) === normalizePath(path))) {
        alreadyPinned.push(path);
      } else {
        newFiles.push(path);
      }
    }
    
    // First, insert new files after the target
    let insertPosition = afterIndex + 1;
    if (newFiles.length > 0) {
      const newItems: PinnedItem[] = newFiles.map(path => ({ type: "file" as const, id: path, data: "" }));
      this.pinnedItems.splice(insertPosition, 0, ...newItems);
      log(`pinFilesAfterItem: Added ${newItems.length} new file(s) after index ${afterIndex}`);
      insertPosition += newItems.length;
    }
    
    // Then, reorder already-pinned files to follow
    if (alreadyPinned.length > 0) {
      for (const path of alreadyPinned) {
        const pinnedId = `pinned:${normalizePath(path)}`;
        const currentIndex = this.pinnedItems.findIndex(item => 
          item.type === "file" && `pinned:${normalizePath(item.id)}` === pinnedId
        );
        if (currentIndex !== -1 && currentIndex !== insertPosition) {
          const [item] = this.pinnedItems.splice(currentIndex, 1);
          // Adjust insert position if we removed from before it
          if (currentIndex < insertPosition) {insertPosition--;}
          this.pinnedItems.splice(insertPosition, 0, item);
          insertPosition++;
        }
      }
      log(`pinFilesAfterItem: Reordered ${alreadyPinned.length} already-pinned file(s)`);
    }
    
    log(`pinFilesAfterItem: Total pinnedItems=${this.pinnedItems.length}`);
    
    this.persistPinnedItems();
    this.refreshTreeOnly();
  }

  /** Persist pinned items to workspace state */
  private persistPinnedItems(): void {
    if (this.context) {
      this.context.workspaceState.update("pinnedItems", this.pinnedItems);
    }
  }

  /** Get all visible file paths (excluding deleted files) for search operations */
  getVisibleFilePaths(): AbsolutePath[] {
    const files: AbsolutePath[] = [];
    for (const [filePath, metadata] of this.freshFiles.entries()) {
      // Skip deleted files and apply current filters
      if (metadata.isDeleted) {
        continue;
      }
      if (this.excludedAuthors.has(metadata.author || "(unknown)")) {
        continue;
      }
      if (metadata.commitHash && this.excludedCommits.has(metadata.commitHash)) {
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
      if (this.excludedAuthors.has(metadata.author || "(unknown)")) {
        continue;
      }
      if (metadata.commitHash && this.excludedCommits.has(metadata.commitHash)) {
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
      if (this.pinnedItems.length > 0 || totalRepos > 0) {
        // Use a virtual URI for the pinned folder
        const pinnedFolderUri = vscode.Uri.parse("freshfiles://pinned");
        const pinnedFolder = FreshFileItem.forPinnedFolder(
          pinnedFolderUri,
          this.openChangesMode,
          this.pinnedItems.length,
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
      return this.buildAuthorFiles(authorName, true);
    }

    // Get children of a commit hash group
    if (element instanceof FreshFileItem && element.contextValue === TreeItemContextValues.COMMIT_HASH_GROUP) {
      const commitHash = element.label as string;
      return this.buildCommitHashFiles(commitHash);
    }

    // Get children of a moon phase group
    if (element instanceof FreshFileItem && element.contextValue === TreeItemContextValues.MOON_PHASE_GROUP) {
      const moonPhaseName = decodeURIComponent(element.resourceUri.path.replace("/", ""));
      return this.buildMoonPhaseFiles(moonPhaseName as MoonPhase);
    }

    // Get children of a retrograde group
    if (element instanceof FreshFileItem && element.contextValue === TreeItemContextValues.RETROGRADE_GROUP) {
      const retrogradeKey = decodeURIComponent(element.resourceUri.path.replace("/", ""));
      return this.buildRetrogradeFiles(retrogradeKey);
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
      return this.buildAuthorGroupedView(results);
    }

    // If grouping by commit hash, build a different structure
    if (this.groupingMode === "commitHash") {
      return this.buildCommitHashGroupedView(results);
    }

    // If grouping by moon phase, build a different structure
    if (this.groupingMode === "moonPhase") {
      return this.buildMoonPhaseGroupedView(results);
    }

    // If grouping by planetary retrograde, build a different structure
    if (this.groupingMode === "retrograde") {
      return this.buildRetrogradeGroupedView(results);
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

  private buildAuthorGroupedView(results: FreshFilesTreeItem[]): FreshFilesTreeItem[] {
    // Group files by author
    const authorGroups = new Map<string, { files: AbsolutePath[]; metadata: FileMetadata }[]>();

    for (const [filePath, metadata] of this.freshFiles) {
      // Apply filters
      if (!this.passesFilters(metadata)) {
        continue;
      }

      // Get author name - use "Unknown" for files without author (pending changes)
      const authorName = metadata.author || "(No author)";

      if (!authorGroups.has(authorName)) {
        authorGroups.set(authorName, []);
      }

      authorGroups.get(authorName)!.push({ files: [filePath], metadata });
    }

    // Sort authors alphabetically
    const sortedAuthors = Array.from(authorGroups.keys()).sort((a, b) => a.localeCompare(b));

    // Create tree items for each author group
    for (const authorName of sortedAuthors) {
      const group = authorGroups.get(authorName)!;
      const fileCount = group.length;

      // Create a virtual URI for the author group
      const authorUri = vscode.Uri.parse(`freshfiles://author/${encodeURIComponent(authorName)}`);
      
      // Get the most recent date from this author's files
      const mostRecentDate = group.reduce((max, item) => {
        return item.metadata.date > max ? item.metadata.date : max;
      }, new Date(0));

      // Create author group item
      const authorItem = FreshFileItem.forDirectory(
        authorUri,
        this.openChangesMode,
        fileCount,
        ConfigService.getAutoExpandDepth() > 0,
      );

      // Customize the label and description for author groups
      authorItem.label = authorName;
      authorItem.description = `${fileCount} file${fileCount === 1 ? "" : "s"}`;
      authorItem.tooltip = formatDirectoryTooltip(fileCount, mostRecentDate);
      authorItem.iconPath = new vscode.ThemeIcon("person");

      // Store author name in context for getChildren to use
      authorItem.contextValue = TreeItemContextValues.AUTHOR_GROUP;

      results.push(authorItem);
    }

    return results;
  }

  private buildAuthorFiles(authorName: string, skipAuthorInDescription: boolean = false): FreshFileItem[] {
    const items: FreshFileItem[] = [];

    // Collect all files by this author with their metadata
    const filesList: Array<{ filePath: AbsolutePath; metadata: FileMetadata }> = [];
    
    for (const [filePath, metadata] of this.freshFiles) {
      // Apply filters
      if (!this.passesFilters(metadata)) {
        continue;
      }

      // Check if this file is by the specified author
      const fileAuthor = metadata.author || "(No author)";
      if (fileAuthor !== authorName) {
        continue;
      }

      filesList.push({ filePath, metadata });
    }

    // Sort by date (most recent first)
    filesList.sort((a, b) => b.metadata.date.getTime() - a.metadata.date.getTime());

    // Create tree items
    for (const { filePath, metadata } of filesList) {
      const uri = vscode.Uri.file(filePath);
      const isDeleted = metadata.isDeleted ?? false;
      const isPending = metadata.isPending ?? false;

      const item = FreshFileItem.forFile(
        uri,
        this.openChangesMode,
        isDeleted,
        metadata.commitHash,
        isPending,
        metadata.status,
      );

      // Get description format, optionally excluding author
      const descriptionFormat = skipAuthorInDescription
        ? { ...ConfigService.getDescriptionFormat(), showAuthor: false }
        : ConfigService.getDescriptionFormat();

      // Add description and tooltip
      item.description = formatFileDescription(metadata, descriptionFormat);
      item.tooltip = formatFileTooltip(metadata);

      items.push(item);
    }

    return items;
  }

  private buildCommitHashGroupedView(results: FreshFilesTreeItem[]): FreshFilesTreeItem[] {
    // Group files by commit hash
    const commitGroups = new Map<string, { files: AbsolutePath[]; metadata: FileMetadata }[]>();

    for (const [filePath, metadata] of this.freshFiles) {
      // Apply filters
      if (!this.passesFilters(metadata)) {
        continue;
      }

      // Skip pending files (no commit hash)
      if (metadata.isPending || !metadata.commitHash) {
        continue;
      }

      const commitHash = metadata.commitHash;

      if (!commitGroups.has(commitHash)) {
        commitGroups.set(commitHash, []);
      }

      commitGroups.get(commitHash)!.push({ files: [filePath], metadata });
    }

    // Sort commit hashes by most recent date
    const sortedCommits = Array.from(commitGroups.entries()).sort((a, b) => {
      const dateA = a[1].reduce((max, item) => (item.metadata.date > max ? item.metadata.date : max), new Date(0));
      const dateB = b[1].reduce((max, item) => (item.metadata.date > max ? item.metadata.date : max), new Date(0));
      return dateB.getTime() - dateA.getTime();
    });

    // Create tree items for each commit group
    for (const [commitHash, group] of sortedCommits) {
      const fileCount = group.length;
      const firstFile = group[0];

      // Create a virtual URI for the commit group
      const commitUri = vscode.Uri.parse(`freshfiles://commit/${commitHash}`);

      // Create commit group item
      const commitItem = FreshFileItem.forDirectory(
        commitUri,
        this.openChangesMode,
        fileCount,
        ConfigService.getAutoExpandDepth() > 0,
      );

      // Customize the label and description
      commitItem.label = commitHash;
      
      // Show file count, author, and truncated commit message
      const commitMessageTruncated = firstFile.metadata.commitMessage 
        ? (firstFile.metadata.commitMessage.length > 40 
            ? firstFile.metadata.commitMessage.substring(0, 40) + "..." 
            : firstFile.metadata.commitMessage)
        : "";
      
      const descriptionParts = [`${fileCount} file${fileCount === 1 ? "" : "s"}`];
      if (firstFile.metadata.author) {
        descriptionParts.push(firstFile.metadata.author);
      }
      if (commitMessageTruncated) {
        descriptionParts.push(commitMessageTruncated);
      }
      commitItem.description = descriptionParts.join(" • ");
      
      // Show commit message in tooltip
      const tooltipLines = [
        `Commit: ${commitHash}`,
        `Author: ${firstFile.metadata.author || "(No author)"}`,
        `Date: ${formatRelativeDate(firstFile.metadata.date)}`,
        `Files: ${fileCount}`,
      ];
      if (firstFile.metadata.commitMessage) {
        tooltipLines.push(`\nMessage:\n${firstFile.metadata.commitMessage}`);
      }
      commitItem.tooltip = tooltipLines.join("\n");
      
      commitItem.iconPath = new vscode.ThemeIcon("git-commit");
      commitItem.contextValue = TreeItemContextValues.COMMIT_HASH_GROUP;

      results.push(commitItem);
    }

    return results;
  }

  private buildCommitHashFiles(commitHash: string): FreshFileItem[] {
    const items: FreshFileItem[] = [];

    // Collect all files with this commit hash
    const filesList: Array<{ filePath: AbsolutePath; metadata: FileMetadata }> = [];

    for (const [filePath, metadata] of this.freshFiles) {
      // Apply filters
      if (!this.passesFilters(metadata)) {
        continue;
      }

      if (metadata.commitHash !== commitHash) {
        continue;
      }

      filesList.push({ filePath, metadata });
    }

    // Sort by date (most recent first)
    filesList.sort((a, b) => b.metadata.date.getTime() - a.metadata.date.getTime());

    // Create tree items (hide commit hash in description)
    for (const { filePath, metadata } of filesList) {
      const uri = vscode.Uri.file(filePath);
      const isDeleted = metadata.isDeleted ?? false;
      const isPending = metadata.isPending ?? false;

      const item = FreshFileItem.forFile(
        uri,
        this.openChangesMode,
        isDeleted,
        metadata.commitHash,
        isPending,
        metadata.status,
      );

      // Hide commit hash in description (redundant)
      const descriptionFormat = { ...ConfigService.getDescriptionFormat(), showCommitHash: false };
      item.description = formatFileDescription(metadata, descriptionFormat);
      item.tooltip = formatFileTooltip(metadata);

      items.push(item);
    }

    return items;
  }

  private buildMoonPhaseGroupedView(results: FreshFilesTreeItem[]): FreshFilesTreeItem[] {
    // Group files by moon phase
    const phaseGroups = new Map<MoonPhase, { files: AbsolutePath[]; metadata: FileMetadata }[]>();

    for (const [filePath, metadata] of this.freshFiles) {
      // Apply filters
      if (!this.passesFilters(metadata)) {
        continue;
      }

      // Get moon phase for this file's date
      const moonPhaseInfo = getMoonPhase(metadata.date);
      const phaseName = moonPhaseInfo.name;

      if (!phaseGroups.has(phaseName)) {
        phaseGroups.set(phaseName, []);
      }

      phaseGroups.get(phaseName)!.push({ files: [filePath], metadata });
    }

    // Define phase order (new moon to waning crescent)
    const phaseOrder: MoonPhase[] = [
      "New Moon",
      "Waxing Crescent",
      "First Quarter",
      "Waxing Gibbous",
      "Full Moon",
      "Waning Gibbous",
      "Last Quarter",
      "Waning Crescent",
    ];

    // Create tree items for each phase that has files
    for (const phaseName of phaseOrder) {
      const group = phaseGroups.get(phaseName);
      if (!group || group.length === 0) {
        continue;
      }

      const fileCount = group.length;
      const moonPhaseInfo = getMoonPhase(group[0].metadata.date); // Get emoji

      // Create a virtual URI for the phase group
      const phaseUri = vscode.Uri.parse(`freshfiles://moonphase/${encodeURIComponent(phaseName)}`);

      // Get most recent date
      const mostRecentDate = group.reduce((max, item) => {
        return item.metadata.date > max ? item.metadata.date : max;
      }, new Date(0));

      // Create phase group item
      const phaseItem = FreshFileItem.forDirectory(
        phaseUri,
        this.openChangesMode,
        fileCount,
        ConfigService.getAutoExpandDepth() > 0,
      );

      phaseItem.label = `${moonPhaseInfo.emoji} ${phaseName}`;
      phaseItem.description = `${fileCount} file${fileCount === 1 ? "" : "s"}`;
      
      const tooltipLines = [
        `Moon Phase: ${phaseName}`,
        `Files: ${fileCount}`,
        `Most recent: ${formatRelativeDate(mostRecentDate)}`,
      ];
      phaseItem.tooltip = tooltipLines.join("\n");
      
      phaseItem.iconPath = new vscode.ThemeIcon("circle-filled");
      phaseItem.contextValue = TreeItemContextValues.MOON_PHASE_GROUP;

      results.push(phaseItem);
    }

    return results;
  }

  private buildMoonPhaseFiles(moonPhaseName: MoonPhase): FreshFileItem[] {
    const items: FreshFileItem[] = [];

    // Collect all files with this moon phase
    const filesList: Array<{ filePath: AbsolutePath; metadata: FileMetadata }> = [];

    for (const [filePath, metadata] of this.freshFiles) {
      // Apply filters
      if (!this.passesFilters(metadata)) {
        continue;
      }

      const moonPhaseInfo = getMoonPhase(metadata.date);
      if (moonPhaseInfo.name !== moonPhaseName) {
        continue;
      }

      filesList.push({ filePath, metadata });
    }

    // Sort by date (most recent first)
    filesList.sort((a, b) => b.metadata.date.getTime() - a.metadata.date.getTime());

    // Create tree items
    for (const { filePath, metadata } of filesList) {
      const uri = vscode.Uri.file(filePath);
      const isDeleted = metadata.isDeleted ?? false;
      const isPending = metadata.isPending ?? false;

      const item = FreshFileItem.forFile(
        uri,
        this.openChangesMode,
        isDeleted,
        metadata.commitHash,
        isPending,
        metadata.status,
      );

      item.description = formatFileDescription(metadata, ConfigService.getDescriptionFormat());
      item.tooltip = formatFileTooltip(metadata);

      items.push(item);
    }

    return items;
  }

  private buildRetrogradeGroupedView(results: FreshFilesTreeItem[]): FreshFilesTreeItem[] {
    // Group files by retrograde combination
    const retrogradeGroups = new Map<string, { files: AbsolutePath[]; metadata: FileMetadata; planets: Planet[] }[]>();

    for (const [filePath, metadata] of this.freshFiles) {
      // Apply filters
      if (!this.passesFilters(metadata)) {
        continue;
      }

      // Get retrograde info for this file's date
      const retrogradeInfo = getRetrogradeInfo(metadata.date);
      const key = getRetrogradeKey(retrogradeInfo.planets);

      if (!retrogradeGroups.has(key)) {
        retrogradeGroups.set(key, []);
      }

      retrogradeGroups.get(key)!.push({ files: [filePath], metadata, planets: retrogradeInfo.planets });
    }

    // Sort groups: "none" first, then by number of planets (more = more chaotic), then alphabetically
    const sortedGroups = Array.from(retrogradeGroups.entries()).sort((a, b) => {
      const keyA = a[0];
      const keyB = b[0];

      // "none" should be first
      if (keyA === "none") {
        return -1;
      }
      if (keyB === "none") {
        return 1;
      }

      // Sort by number of planets (descending - most chaotic first)
      const planetsA = a[1][0].planets.length;
      const planetsB = b[1][0].planets.length;
      if (planetsA !== planetsB) {
        return planetsB - planetsA;
      }

      // Then alphabetically
      return keyA.localeCompare(keyB);
    });

    // Create tree items for each retrograde combination
    for (const [key, group] of sortedGroups) {
      const fileCount = group.length;
      const retrogradeInfo = getRetrogradeInfo(group[0].metadata.date);

      // Create a virtual URI for the retrograde group
      const retrogradeUri = vscode.Uri.parse(`freshfiles://retrograde/${encodeURIComponent(key)}`);

      // Get most recent date
      const mostRecentDate = group.reduce((max, item) => {
        return item.metadata.date > max ? item.metadata.date : max;
      }, new Date(0));

      // Create retrograde group item
      const retrogradeItem = FreshFileItem.forDirectory(
        retrogradeUri,
        this.openChangesMode,
        fileCount,
        ConfigService.getAutoExpandDepth() > 0,
      );

      retrogradeItem.label = retrogradeInfo.displayName;
      retrogradeItem.description = `${fileCount} file${fileCount === 1 ? "" : "s"}`;
      
      const tooltipLines = [
        `Retrograde: ${retrogradeInfo.displayName}`,
        `Files: ${fileCount}`,
        `Most recent: ${formatRelativeDate(mostRecentDate)}`,
      ];
      retrogradeItem.tooltip = tooltipLines.join("\n");
      
      retrogradeItem.iconPath = new vscode.ThemeIcon(key === "none" ? "check" : "globe");
      retrogradeItem.contextValue = TreeItemContextValues.RETROGRADE_GROUP;

      results.push(retrogradeItem);
    }

    return results;
  }

  private buildRetrogradeFiles(retrogradeKey: string): FreshFileItem[] {
    const items: FreshFileItem[] = [];

    // Collect all files with this retrograde combination
    const filesList: Array<{ filePath: AbsolutePath; metadata: FileMetadata }> = [];

    for (const [filePath, metadata] of this.freshFiles) {
      // Apply filters
      if (!this.passesFilters(metadata)) {
        continue;
      }

      const retrogradeInfo = getRetrogradeInfo(metadata.date);
      const key = getRetrogradeKey(retrogradeInfo.planets);
      
      if (key !== retrogradeKey) {
        continue;
      }

      filesList.push({ filePath, metadata });
    }

    // Sort by date (most recent first)
    filesList.sort((a, b) => b.metadata.date.getTime() - a.metadata.date.getTime());

    // Create tree items
    for (const { filePath, metadata } of filesList) {
      const uri = vscode.Uri.file(filePath);
      const isDeleted = metadata.isDeleted ?? false;
      const isPending = metadata.isPending ?? false;

      const item = FreshFileItem.forFile(
        uri,
        this.openChangesMode,
        isDeleted,
        metadata.commitHash,
        isPending,
        metadata.status,
      );

      item.description = formatFileDescription(metadata, ConfigService.getDescriptionFormat());
      item.tooltip = formatFileTooltip(metadata);

      items.push(item);
    }

    return items;
  }

  private buildPinnedItems(): FreshFilesTreeItem[] {
    const items: FreshFilesTreeItem[] = [];

    // Iterate in order
    for (const pinnedItem of this.pinnedItems) {
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

    this.errorToShowInTreeView = undefined;
    const newFiles = new Map<AbsolutePath, FileMetadata>();

    // Reset git repos for all folders
    for (const folder of this.workspaceFolders) {
      folder.gitRepos = [];
    }

    // Process each workspace folder
    for (const folder of this.workspaceFolders) {
      await this.updateFreshFilesForFolder(folder, newFiles);
    }

    const totalRepos = this.workspaceFolders.reduce((sum, folder) => sum + folder.gitRepos.length, 0);
    log(
      `Found ${totalRepos} Git repository(ies) across ${this.workspaceFolders.length} workspace folder(s) with ${newFiles.size} total fresh files`,
    );

    this.freshFiles = newFiles;
    this.dataLoaded = true;

    // Update contexts for viewsWelcome
    vscode.commands.executeCommand("setContext", "freshFileExplorer.hasRepos", totalRepos > 0);
    vscode.commands.executeCommand("setContext", "freshFileExplorer.loading", false);

    // Notify heatmap decoration provider of data changes
    this.heatmapProvider?.fireDidChange();
  }

  private async updateFreshFilesForFolder(
    folder: WorkspaceFolderInfo,
    targetMap: Map<AbsolutePath, FileMetadata>,
  ): Promise<void> {
    // First, try the folder root as a git repo
    const rootIsGit = await isGitRepository(folder.path);

    if (rootIsGit) {
      log(`Workspace folder "${folder.name}" is a Git repository`);
      folder.gitRepos.push("");
      await this.collectFilesFromRepo(folder, "", targetMap);
    } else {
      // Folder is not a git repo, look for git repos in immediate subdirectories
      log(`Workspace folder "${folder.name}" is not a Git repository, scanning subdirectories...`);
      const subRepos = await discoverGitReposInSubdirs(folder.path);
      for (const repo of subRepos) {
        folder.gitRepos.push(repo);
        await this.collectFilesFromRepo(folder, repo, targetMap);
      }
    }
  }

  /**
   * Add files from a collection to target map, avoiding duplicates
   */
  private addFilesToFreshFiles(
    folder: WorkspaceFolderInfo,
    files: Map<string, FileMetadata>,
    targetMap: Map<AbsolutePath, FileMetadata>,
  ): void {
    for (const [filePath, metadata] of files) {
      const absolutePath = asAbsolutePath(normalizePath(path.join(folder.path, filePath)));
      if (!targetMap.has(absolutePath)) {
        targetMap.set(absolutePath, metadata);
      }
    }
  }

  private async collectFilesFromRepo(
    folder: WorkspaceFolderInfo,
    repoRelativePath: string,
    targetMap: Map<AbsolutePath, FileMetadata>,
  ): Promise<void> {
    const repoFullPath = repoRelativePath ? path.join(folder.path, repoRelativePath) : folder.path;
    const filesBefore = targetMap.size;

    // Check if we're in "pending changes only" mode
    if (isPendingChangesMode(this.currentTimeWindow)) {
      // Only show pending changes
      try {
        const files = await collectPendingChanges(repoRelativePath, repoFullPath, folder.path);
        this.addFilesToFreshFiles(folder, files, targetMap);
      } catch (error) {
        const errorMessage = String(error);
        log(
          `Failed to get pending changes from ${folder.name}/${repoRelativePath || "root"}: ${errorMessage}`,
          "error",
        );
        if (!this.errorToShowInTreeView) {
          this.errorToShowInTreeView = `Error: ${errorMessage}`;
        }
      }
    } else {
      // Historical mode: Show both pending changes AND historical changes within time window

      // First, try to get pending changes (they're the most recent)
      try {
        const pendingFiles = await collectPendingChanges(repoRelativePath, repoFullPath, folder.path);
        this.addFilesToFreshFiles(folder, pendingFiles, targetMap);
      } catch (error) {
        const errorMessage = String(error);
        log(`Failed to get pending changes from ${folder.name}/${repoRelativePath || "root"}: ${errorMessage}`, "warn");
        // Don't set error yet - we can still try historical
      }

      // Then, try to get historical changes from git log
      try {
        const historicalFiles = await collectHistoricalChanges(
          repoRelativePath,
          repoFullPath,
          folder.path,
          this.currentTimeWindow.days,
        );
        this.addFilesToFreshFiles(folder, historicalFiles, targetMap);
      } catch (error) {
        const errorMessage = String(error);
        if (errorMessage.includes("your current branch does not have any commits yet")) {
          log(`No commits yet in repo ${folder.name}/${repoRelativePath || "root"}`);
          // Don't set error if we got some files from pending changes
          if (targetMap.size === filesBefore) {
            if (!this.errorToShowInTreeView) {
              this.errorToShowInTreeView = "This repository has no commits yet. Add and commit files to see them here.";
            }
          }
        } else {
          log(
            `Failed to get historical changes from ${folder.name}/${repoRelativePath || "root"}: ${errorMessage}`,
            "warn",
          );
          // Only set error if we also failed to get pending changes
          if (targetMap.size === filesBefore && !this.errorToShowInTreeView) {
            this.errorToShowInTreeView = `Git error: ${errorMessage}`;
          }
        }
      }
    }

    const filesAdded = targetMap.size - filesBefore;
    log(
      `Collected ${filesAdded} file(s) from ${folder.name}/${repoRelativePath || "root"}, total now: ${targetMap.size}`,
    );
  }

  /** Check if a file passes the current filters */
  private passesFilters(metadata: FileMetadata): boolean {
    if (this.excludedAuthors.size === 0 && this.excludedCommits.size === 0) {
      return true;
    }
    const author = metadata.author || "(unknown)";
    const commitHash = metadata.commitHash;

    if (this.excludedAuthors.has(author)) {
      return false;
    }
    if (commitHash && this.excludedCommits.has(commitHash)) {
      return false;
    }
    return true;
  }

  private countFilesInDirectory(dirPath: string): number {
    let count = 0;
    const normalizedDir = normalizePath(dirPath);
    const prefix = normalizedDir + "/";

    for (const [filePath, metadata] of this.freshFiles) {
      const normalizedFile = normalizePath(filePath);
      if (normalizedFile.startsWith(prefix)) {
        if (this.passesFilters(metadata)) {
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
        if (this.passesFilters(metadata)) {
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
      if (!this.passesFilters(metadata)) {
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
