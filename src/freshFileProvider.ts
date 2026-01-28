import * as vscode from "vscode";
import * as path from "path";

import { ConfigService } from "./config/configService";
import {
  WorkspaceFolderInfo,
  FileMetadata,
  AuthorData,
  CommitData,
  BranchName,
  CommitHash,
  CommitAuthor,
  asCommitAuthor,
  CommitDataWithFileCount,
  asCommitMessage,
} from "./types";
import { buildTimeWindows, isPendingChangesMode, TimeWindow } from "./timeWindowUtils";
import { AbsolutePath, asAbsolutePath } from "./pathTypes";
import { formatFileDescription, formatFileTooltip, formatDirectoryTooltip } from "./utils/formatUtils";
import { log } from "./utils/logger";
import { FreshFileItem, MessageTreeItem as MessageTreeItem, FreshFilesTreeItem } from "./treeItems";
import { normalizePath } from "./utils";
import {
  collectHistoricalChanges,
  collectPendingChanges,
  discoverGitReposInSubdirs,
  isGitRepository,
} from "./git/gitOperations";

export class FreshFileProvider implements vscode.TreeDataProvider<FreshFilesTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<FreshFilesTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // Map of absolute file path to file metadata
  private freshFiles: Map<AbsolutePath, FileMetadata> = new Map();
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

  // Open mode toggle - persisted
  openChangesMode: boolean = false;

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

  /** Check if we have any Git repositories */
  hasGitRepositories(): boolean {
    return this.workspaceFolders.some(folder => folder.gitRepos.length > 0);
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

      // Collect results: sync warnings first, then files or empty message
      const results: FreshFilesTreeItem[] = [];

      // Always show sync warnings at the top
      if (this.syncWarnings.length > 0) {
        results.push(...this.syncWarnings.map(w => new MessageTreeItem(w, "warning")));
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

    // Get children of a directory
    if (element instanceof FreshFileItem) {
      return this.buildTree(element.resourceUri.fsPath);
    }

    log("getChildren returning empty array (unknown element type)");
    return [];
  }

  private buildRepoView(results: FreshFilesTreeItem[], contextValue: string) {
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

  private getMostRecentDateInDirectory(dirPath: string): Date | undefined {
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

    // Sort: directories first, then alphabetically
    items.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return path.basename(a.resourceUri.fsPath).localeCompare(path.basename(b.resourceUri.fsPath));
    });

    return items;
  }
}
