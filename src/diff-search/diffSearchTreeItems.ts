import * as vscode from "vscode";
import * as path from "path";
import { AbsolutePath } from "../pathTypes";
import { CommitHash } from "../types";
import { Commands } from "../commands/commandConstants";
import { formatRelativeDate, shortSha } from "../utils/formatUtils";
import { DiffSearchContextValues } from "./diffSearchConstants";

/**
 * Tree item representing a file with diff matches
 */
export class DiffSearchFileItem extends vscode.TreeItem {
  constructor(
    public readonly filePath: AbsolutePath,
    public readonly matchCount: number,
    public readonly commitHash?: CommitHash, // Undefined for pending changes
    public readonly repoName?: string,
  ) {
    const fileName = path.basename(filePath);
    const dirName = path.dirname(filePath);
    
    // Make label completely unique with full path and random suffix
    const randomSuffix = Math.random().toString(36).substring(2, 7);
    const label = commitHash 
      ? `${fileName} (${dirName}) [${shortSha(commitHash)}] #${randomSuffix}` 
      : `${fileName} (${dirName}) [pending] #${randomSuffix}`;
    
    super(label, vscode.TreeItemCollapsibleState.Collapsed);

    this.description = `${matchCount} ${matchCount === 1 ? "match" : "matches"}`;
    this.tooltip = new vscode.MarkdownString(
      `**${fileName}**\n\n${dirName}\n\n${matchCount} ${matchCount === 1 ? "match" : "matches"} found`,
    );

    // Use file icon (don't set resourceUri to avoid conflicts when same file appears in multiple commits)
    this.iconPath = vscode.ThemeIcon.File;

    // Use random ID to avoid any caching/identity conflicts
    this.id = `file-${Math.random().toString(36).substring(2, 15)}-${Date.now()}`;

    // Set context value for context menu
    this.contextValue = DiffSearchContextValues.FILE;
  }
}

/**
 * Tree item representing a single diff match (added or removed line)
 */
export class DiffSearchMatchItem extends vscode.TreeItem {
  constructor(
    public readonly filePath: AbsolutePath,
    public readonly lineNumber: number,
    public readonly lineContent: string,
    public readonly changeType: "added" | "removed",
    public readonly commitHash?: CommitHash,
    public readonly commitMessage?: string,
    public readonly isStaged?: boolean,
    public readonly fileAdded?: boolean,
  ) {
    super(lineContent, vscode.TreeItemCollapsibleState.None);

    // Create label with line number and preview
    const truncatedContent = lineContent.length > 80 ? lineContent.substring(0, 77) + "..." : lineContent;
    this.label = `L${lineNumber}: ${truncatedContent}`;

    // Set unique ID
    this.id = `match-${Math.random().toString(36).substring(2, 15)}-${Date.now()}`;

    // Use appropriate icon based on change type
    if (changeType === "added") {
      this.iconPath = new vscode.ThemeIcon("add", new vscode.ThemeColor("gitDecoration.addedResourceForeground"));
    } else {
      this.iconPath = new vscode.ThemeIcon("remove", new vscode.ThemeColor("gitDecoration.deletedResourceForeground"));
    }

    // Build tooltip with more context
    const tooltipLines: string[] = [`**Line ${lineNumber}**`, "", truncatedContent !== lineContent ? lineContent : ""];

    if (commitHash) {
      tooltipLines.push("", `Commit: ${shortSha(commitHash)}`);
      if (commitMessage) {
        tooltipLines.push(`Message: ${commitMessage}`);
      }
    } else if (isStaged !== undefined) {
      tooltipLines.push("", isStaged ? "Staged change" : "Unstaged change");
    }

    this.tooltip = new vscode.MarkdownString(tooltipLines.filter(l => l !== "").join("\n"));

    // Set context value
    this.contextValue = DiffSearchContextValues.MATCH;

    // Set command to open diff at this line
    this.command = {
      command: Commands.OPEN_DIFF_MATCH,
      title: "Open Diff",
      arguments: [this],
    };
  }
}

/**
 * Tree item for repo grouping in multi-repo workspaces
 */
export class DiffSearchRepoItem extends vscode.TreeItem {
  constructor(
    public readonly repoName: string,
    public readonly matchCount: number,
  ) {
    super(repoName, matchCount > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);

    this.description = `${matchCount} ${matchCount === 1 ? "match" : "matches"}`;
    this.iconPath = new vscode.ThemeIcon("repo");
    this.contextValue = DiffSearchContextValues.REPO;
  }
}

/**
 * Tree item for commit grouping
 */
export class DiffSearchCommitItem extends vscode.TreeItem {
  constructor(
    public readonly commitHash: CommitHash,
    public readonly commitMessage: string,
    public readonly commitDate: Date,
    public readonly fileCount: number,
    public readonly matchCount: number,
  ) {
    super(commitMessage, vscode.TreeItemCollapsibleState.Collapsed);

    const commitShort = shortSha(commitHash);
    this.label = `${commitShort} - ${commitMessage}`;
    const relativeDate = formatRelativeDate(commitDate);
    const absoluteDate = commitDate.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    this.description = `${relativeDate} · ${fileCount} ${fileCount === 1 ? "file" : "files"}, ${matchCount} ${matchCount === 1 ? "match" : "matches"}`;
    
    this.tooltip = new vscode.MarkdownString(
      `**${commitShort}** - ${commitMessage}\n\n${relativeDate} (${absoluteDate})\n\n${fileCount} ${fileCount === 1 ? "file" : "files"} with ${matchCount} ${matchCount === 1 ? "match" : "matches"}`,
    );

    this.iconPath = new vscode.ThemeIcon("git-commit");
    this.contextValue = DiffSearchContextValues.COMMIT;
    this.id = `commit-${Math.random().toString(36).substring(2, 15)}-${Date.now()}`;

    // Auto-expand if few files
    if (fileCount <= 3) {
      this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    }
  }
}

/**
 * Tree item for pending changes group
 */
export class DiffSearchPendingItem extends vscode.TreeItem {
  constructor(
    public readonly fileCount: number,
    public readonly matchCount: number,
  ) {
    super("Pending Changes", vscode.TreeItemCollapsibleState.Expanded);

    this.description = `${fileCount} ${fileCount === 1 ? "file" : "files"}, ${matchCount} ${matchCount === 1 ? "match" : "matches"}`;
    this.tooltip = new vscode.MarkdownString(
      `Uncommitted changes (staged + unstaged)\n\n${fileCount} ${fileCount === 1 ? "file" : "files"} with ${matchCount} ${matchCount === 1 ? "match" : "matches"}`,
    );
    this.iconPath = new vscode.ThemeIcon("git-branch");
    this.contextValue = DiffSearchContextValues.PENDING;
    this.id = `pending-${Math.random().toString(36).substring(2, 15)}-${Date.now()}`;
  }
}

/**
 * Union type for all diff search tree items
 */
export type DiffSearchTreeItem =
  | DiffSearchFileItem
  | DiffSearchMatchItem
  | DiffSearchRepoItem
  | DiffSearchCommitItem
  | DiffSearchPendingItem;
