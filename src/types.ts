import * as path from "path";
import { AbsolutePath, asAbsolutePath } from "./pathTypes";

/**
 * Branded type for Git commit hashes
 * Used to distinguish commit hashes from regular strings at compile time
 */
export type CommitHash = string & { readonly __brand: "commitHash" };

/**
 * Branded type for Git references (refs)
 * Used for HEAD, branch names, tags, or commit refs like "HEAD~1"
 */
export type GitRef = string & { readonly __brand: "gitRef" };

/**
 * Branded type for Git branch names
 * Used to distinguish branch names from regular strings at compile time
 */
export type BranchName = string & { readonly __brand: "branchName" };

/**
 * Branded type for Git commit authors
 */
export type CommitAuthor = string & { readonly __brand: "commitAuthor" };

/**
 * Branded type for Git commit messages
 */
export type CommitMessage = string & { readonly __brand: "commitMessage" };

/**
 * Sort order for files in the tree view
 */
export type SortOrder = "name" | "date" | "author";

export function asCommitHash(value: string) {
  return value as CommitHash;
}

export function asGitRef(value: string) {
  return value as GitRef;
}

export function asBranchName(value: string) {
  return value as BranchName;
}

export function asCommitMessage(value: string) {
  return value as CommitMessage;
}

export function asCommitAuthor(value: string) {
  return value as CommitAuthor;
}

/**
 * Types for pinned items
 */
export type PinnedItemType = "note" | "file";

export interface PinnedItem {
  type: PinnedItemType;
  id: string; // noteId for notes, file path for files
  data: string; // note text for notes, empty for files
  /** For notes only: whether the note is marked completed (todo done) */
  completed?: boolean;
}


/**
 * Metadata about a file's last modification
 */
export interface FileMetadata {
  date: Date;
  author?: CommitAuthor;
  commitHash?: CommitHash;
  commitMessage?: CommitMessage;
  status?: string; // For pending changes: 'M', 'A', '??', 'D', etc.
  isDeleted?: boolean; // True if the file has been deleted
  isPending?: boolean; // True if this is a pending (uncommitted) change
  linesAdded?: number; // Number of lines added in this change
  linesDeleted?: number; // Number of lines deleted in this change
}

/**
 * Configuration for what to show in the file description
 */
export interface DescriptionFormat {
  showDate: boolean;
  showAuthor: boolean;
  showCommitHash: boolean;
  showCommitMessage: boolean;
  showStatus: boolean; // For pending changes
  showLineChanges: boolean; // Show +X -Y line change counts
}

export const DEFAULT_DESCRIPTION_FORMAT: DescriptionFormat = {
  showDate: true,
  showAuthor: true,
  showCommitHash: false,
  showCommitMessage: true,
  showStatus: true,
  showLineChanges: true,
};

/**
 * Workspace folder with its git repositories
 */
export interface WorkspaceFolderInfo {
  path: AbsolutePath;
  name: string;
  // Git repos in this folder (paths relative to folder root, empty string = folder root is repo)
  gitRepos: string[];
}

export interface CommitData {
  hash: CommitHash;
  message: CommitMessage;
  author: CommitAuthor;
  date: Date;
  repoName?: string;
}

export interface CommitDataWithFileCount extends CommitData {
  fileCount: number;
}
export interface AuthorData {
  author: CommitAuthor | "(unknown)";
  fileCount: number;
}

/**
 * Result of finding which git repository a file belongs to
 */
export interface RepoLocationResult {
  repoFullPath: AbsolutePath;
  repoRelativePath: string; // Empty string if folder root is the repo
  filePathInRepo: string;
}

/**
 * Find which git repository a file belongs to within a workspace folder
 * @param folder The workspace folder containing git repositories
 * @param fileRelativePath Path to the file relative to the workspace folder (must be normalized)
 * @returns Repository location information, or undefined if file doesn't belong to any repo
 */
export function findRepoForFile(folder: WorkspaceFolderInfo, fileRelativePath: string): RepoLocationResult | undefined {
  for (const repo of folder.gitRepos) {
    if (repo === "") {
      // Folder root is the repo
      return {
        repoFullPath: folder.path,
        repoRelativePath: "",
        filePathInRepo: fileRelativePath,
      };
    } else if (fileRelativePath.startsWith(repo + "/")) {
      // File is in a subdirectory repo
      return {
        repoFullPath: asAbsolutePath(path.join(folder.path, repo)),
        repoRelativePath: repo,
        filePathInRepo: fileRelativePath.substring(repo.length + 1),
      };
    }
  }
  return undefined;
}
