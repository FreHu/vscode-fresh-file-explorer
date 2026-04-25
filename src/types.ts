import { AbsolutePath } from "./pathTypes";

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
  renameSource?: string; // For renames: repo-relative path of the old file
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
  showLineChanges: false,
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
  /** Committer's timezone offset in minutes east of UTC (from `git log %aI`). */
  tzOffsetMinutes?: number;
  repoName?: string;
}

export interface CommitDataWithFileCount extends CommitData {
  fileCount: number;
}

/** Per-commit file-change breakdown, accumulated during the git log stream. */
export interface CommitStats {
  commit: CommitData;
  added: number;
  deleted: number;
  modified: number;
}

export interface AuthorData {
  author: CommitAuthor | "(unknown)";
  fileCount: number;
}


