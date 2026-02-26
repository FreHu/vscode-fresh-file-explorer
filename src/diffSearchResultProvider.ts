import * as vscode from "vscode";
import * as path from "path";
import { DiffMatch } from "./git/gitDiffSearch";
import { groupBy } from "./utils/collectionUtils";
import {
  DiffSearchFileItem,
  DiffSearchMatchItem,
  DiffSearchRepoItem,
  DiffSearchCommitItem,
  DiffSearchPendingItem,
  DiffSearchTreeItem,
} from "./diffSearchTreeItems";
import { AbsolutePath } from "./pathTypes";
import { CommitHash } from "./types";
import { log } from "./extension/logger";
import { ContextManager } from "./extension/contextManager";

/**
 * Tree data provider for diff search results
 */
export class DiffSearchResultProvider implements vscode.TreeDataProvider<DiffSearchTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<DiffSearchTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private searchPattern: string = "";
  private allMatches: DiffMatch[] = [];
  private repoNames = new Map<AbsolutePath, string>(); // repo path -> repo name
  
  // Performance optimization: cache groupings to avoid rebuilding on every display
  private commitGroupsCache: Map<CommitHash, DiffMatch[]> | null = null;
  private pendingMatchesCache: DiffMatch[] | null = null;

  /**
   * Show search results in the tree view
   * @param pattern The search pattern used
   * @param matches Array of diff matches
   * @param repoNames Map of repo paths to repo names
   */
  showResults(pattern: string, matches: DiffMatch[], repoNames: Map<AbsolutePath, string>): void {
    this.searchPattern = pattern;
    this.allMatches = matches;
    this.repoNames = repoNames;

    // Build caches for better performance with large result sets
    const pending = matches.filter(m => !m.commitHash);
    const historical = matches.filter(m => !!m.commitHash);
    this.commitGroupsCache = groupBy(historical, m => m.commitHash!);
    this.pendingMatchesCache = pending;

    // Set context for view visibility
    ContextManager.setDiffSearchHasResults(matches.length > 0);

    this._onDidChangeTreeData.fire();
  }

  /**
   * Clear all search results
   */
  clear(): void {
    this.searchPattern = "";
    this.allMatches = [];
    this.repoNames.clear();
    
    // Clear caches
    this.commitGroupsCache = null;
    this.pendingMatchesCache = null;

    ContextManager.setDiffSearchHasResults(false);
    this._onDidChangeTreeData.fire();
  }

  /**
   * Get the current search pattern
   */
  getSearchPattern(): string {
    return this.searchPattern;
  }

  /**
   * Get the current matches
   */
  getMatches(): DiffMatch[] {
    return this.allMatches;
  }

  /**
   * Get tree item - required by TreeDataProvider
   */
  getTreeItem(element: DiffSearchTreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * Get children - required by TreeDataProvider
   */
  async getChildren(element?: DiffSearchTreeItem): Promise<DiffSearchTreeItem[]> {
    // No results yet
    if (this.allMatches.length === 0) {
      if (this.searchPattern) {
        // Had a search but no results
        const item = new vscode.TreeItem("No matches found");
        item.iconPath = new vscode.ThemeIcon("info");
        return [item as any];
      } else {
        // No search performed yet
        return [];
      }
    }

    // Root level - always show repos for consistency
    if (!element) {
      return this.getRepoGroups();
    }

    // Repo level - show commits + pending changes for that repo
    if (element instanceof DiffSearchRepoItem) {
      return this.getCommitGroups(element.repoName);
    }

    // Commit level - show files in that commit
    if (element instanceof DiffSearchCommitItem) {
      const items = this.getFilesForCommit(element.commitHash);
      return items;
    }

    // Pending changes level - show files with pending changes
    if (element instanceof DiffSearchPendingItem) {
      const items = this.getFilesForPending();
      return items;
    }

    // File level - show matches in that file (optionally filtered by commit)
    if (element instanceof DiffSearchFileItem) {
      const items = this.getMatchesForFile(element.filePath, element.commitHash);
      return items;
    }

    return [];
  }

  /**
   * Get repo groups (always shown at root level)
   */
  private getRepoGroups(): DiffSearchRepoItem[] {    
    // Group matches by repo
    const repoGroups = groupBy(
      this.allMatches.filter(match => {
        const repoPath = this.getRepoPathForFile(match.filePath);
        if (!repoPath) {
          log(`WARNING: Could not find repo for file: ${match.filePath}`, "warn");
        }
        return !!repoPath;
      }),
      match => this.getRepoPathForFile(match.filePath)!
    );
        
    const items: DiffSearchRepoItem[] = [];
    for (const [repoPath, matches] of repoGroups) {
      const repoName = this.repoNames.get(repoPath) || path.basename(repoPath);
      const matchCount = matches.length;
      items.push(new DiffSearchRepoItem(repoName, matchCount));
    }
    
    // Sort repos alphabetically
    items.sort((a, b) => a.repoName.localeCompare(b.repoName));
    return items;
  }

  /**
   * Get repo path for a file path
   */
  private getRepoPathForFile(filePath: AbsolutePath): AbsolutePath | null {
    // Try to find which repo this file belongs to by checking if the file path starts with any repo path
    for (const [repoPath] of this.repoNames) {
      // Normalize paths for comparison (handle forward/backslash differences)
      const normalizedFilePath = filePath.replace(/\\/g, '/').toLowerCase();
      const normalizedRepoPath = repoPath.replace(/\\/g, '/').toLowerCase();
      
      // Ensure repo path ends with / for proper matching
      const repoPathWithSlash = normalizedRepoPath.endsWith('/') ? normalizedRepoPath : normalizedRepoPath + '/';
      const filePathWithSlash = normalizedFilePath.endsWith('/') ? normalizedFilePath : normalizedFilePath + '/';
      
      if (filePathWithSlash.startsWith(repoPathWithSlash) || normalizedFilePath === normalizedRepoPath) {
        return repoPath;
      }
    }
    return null;
  }

  /**
   * Get commit groups + pending changes (root level or filtered by repo)
   * @param repoName Optional repo name to filter by (for multi-repo)
   */
  private getCommitGroups(repoName?: string): DiffSearchTreeItem[] {
    const items: DiffSearchTreeItem[] = [];

    // Filter matches by repo if specified
    let matchesToProcess = this.allMatches;
    if (repoName) {
      // Find the repo path for this repo name
      let repoPath: AbsolutePath | null = null;
      for (const [rPath, name] of this.repoNames) {
        if (name === repoName) {
          repoPath = rPath;
          break;
        }
      }
      if (repoPath) {
        matchesToProcess = this.allMatches.filter(m => this.getRepoPathForFile(m.filePath) === repoPath);
      }
    }

    // Use cached groupings if available and not filtering by repo, otherwise build from scratch
    let commitGroups: Map<CommitHash, DiffMatch[]>;
    let pendingMatches: DiffMatch[];
    
    if (!repoName && this.commitGroupsCache && this.pendingMatchesCache) {
      // Use cache (much faster for large result sets) - only when not filtering
      commitGroups = this.commitGroupsCache;
      pendingMatches = this.pendingMatchesCache;
    } else {
      // Build from scratch (fallback for legacy code path or when filtering by repo)
      pendingMatches = matchesToProcess.filter(m => !m.commitHash);
      commitGroups = groupBy(matchesToProcess.filter(m => !!m.commitHash), m => m.commitHash!);

      // Cache for next time (only if not filtering by repo)
      if (!repoName) {
        this.commitGroupsCache = commitGroups;
        this.pendingMatchesCache = pendingMatches;
      }
    }

    // Add commit items (sorted by date, newest first)
    const commitItems: DiffSearchCommitItem[] = [];
    for (const [commitHash, matches] of commitGroups) {
      const firstMatch = matches[0];
      const message = firstMatch.commitMessage || "(no message)";
      const date = firstMatch.commitDate || new Date();
      const fileCount = new Set(matches.map(m => m.filePath)).size;

      commitItems.push(new DiffSearchCommitItem(commitHash, message, date, fileCount, matches.length));
    }
    commitItems.sort((a, b) => b.commitDate.getTime() - a.commitDate.getTime());
    items.push(...commitItems);

    // Add pending changes if any
    if (pendingMatches.length > 0) {
      const fileCount = new Set(pendingMatches.map(m => m.filePath)).size;
      items.unshift(new DiffSearchPendingItem(fileCount, pendingMatches.length));
    }

    return items;
  }

  /**
   * Get files for a specific commit
   */
  private getFilesForCommit(commitHash: CommitHash): DiffSearchFileItem[] {
    // Use cached commit groups if available (much faster for large result sets)
    const commitMatches = this.commitGroupsCache?.get(commitHash);
    const matchesToProcess = commitMatches || this.allMatches.filter(m => m.commitHash === commitHash);

    const fileGroups = groupBy(matchesToProcess, m => m.filePath);
    const items = Array.from(fileGroups.entries()).map(
      ([filePath, matches]) => new DiffSearchFileItem(filePath, matches.length, commitHash)
    );
    return sortFileItemsByName(items);
  }

  /**
   * Get files for pending changes
   */
  private getFilesForPending(): DiffSearchFileItem[] {
    // Use cached pending matches if available (much faster for large result sets)
    const matchesToProcess = this.pendingMatchesCache || this.allMatches.filter(m => !m.commitHash);
    const fileGroups = groupBy(matchesToProcess, m => m.filePath);
    const items = Array.from(fileGroups.entries()).map(
      ([filePath, matches]) => new DiffSearchFileItem(filePath, matches.length, undefined) // undefined = pending
    );
    return sortFileItemsByName(items);
  }

  /**
   * Get matches for a specific file (filtered by commit if applicable)
   */
  private getMatchesForFile(filePath: AbsolutePath, commitHash: CommitHash | undefined): DiffSearchMatchItem[] {
    let matches: DiffMatch[];

    if (commitHash) {
      // Historical file - get from cached commit group if available
      const commitMatches = this.commitGroupsCache?.get(commitHash);
      if (commitMatches) {
        matches = commitMatches.filter(m => m.filePath === filePath);
      } else {
        matches = this.allMatches.filter(m => m.filePath === filePath && m.commitHash === commitHash);
      }
    } else {
      // Pending file - get from cached pending matches if available
      const pendingMatches = this.pendingMatchesCache;
      if (pendingMatches) {
        matches = pendingMatches.filter(m => m.filePath === filePath);
      } else {
        matches = this.allMatches.filter(m => m.filePath === filePath && !m.commitHash);
      }
    }

    // Sort by line number so modifications (remove + add at same line) appear together
    matches.sort((a, b) => a.lineNumber - b.lineNumber);

    return matches.map(
      m =>
        new DiffSearchMatchItem(
          m.filePath,
          m.lineNumber,
          m.lineContent,
          m.changeType,
          m.commitHash,
          m.commitMessage,
          m.isStaged,
          m.fileAdded,
        ),
    );
  }
}

function sortFileItemsByName(items: DiffSearchFileItem[]): DiffSearchFileItem[] {
  return items.sort((a, b) => path.basename(a.filePath).localeCompare(path.basename(b.filePath)));
}
