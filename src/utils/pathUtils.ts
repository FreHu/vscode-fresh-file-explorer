import * as path from "path";
import * as vscode from "vscode";
import { AbsolutePath, asAbsolutePath, NormalizedRepoPath } from "../pathTypes";
import { WorkspaceFolderInfo } from "../types";
import { normalizePath } from "../utils";

/**
 * A git repository discovered in the workspace, expanded from the
 * `(workspaceFolder, repoRel)` pair into the path forms callers actually use.
 */
export interface WorkspaceRepoInfo {
  /** Display name — the workspace-folder name for a root repo, else the basename. */
  name: string;
  /** Absolute path to the repo root. */
  repoFullPath: AbsolutePath;
  /** Normalized form of `repoFullPath`, suitable as a map / workspace-state key. */
  normalizedPath: NormalizedRepoPath;
  /** Repo path relative to its workspace folder; `""` when the folder root is the repo. */
  repoRel: string;
}

/**
 * Expand every workspace folder's `gitRepos` into {@link WorkspaceRepoInfo}.
 * Pure reformatter — does no git work.
 */
export function listWorkspaceRepos(workspaceFolders: WorkspaceFolderInfo[]): WorkspaceRepoInfo[] {
  const out: WorkspaceRepoInfo[] = [];
  for (const folder of workspaceFolders) {
    for (const repoRel of folder.gitRepos) {
      const repoFullPath = repoRel === ""
        ? folder.path
        : asAbsolutePath(path.join(folder.path, repoRel));
      out.push({
        name: repoRel === "" ? folder.name : path.basename(repoFullPath),
        repoFullPath,
        normalizedPath: normalizePath(repoFullPath) as NormalizedRepoPath,
        repoRel,
      });
    }
  }
  return out;
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
  let best: RepoLocationResult | undefined;
  let bestLen = -1;

  for (const repo of folder.gitRepos) {
    if (repo === "") {
      // Folder root is the repo — matches everything, but only use as fallback
      if (bestLen < 0) {
        best = {
          repoFullPath: folder.path,
          repoRelativePath: "",
          filePathInRepo: fileRelativePath,
        };
        bestLen = 0;
      }
    } else if (fileRelativePath.startsWith(repo + "/") && repo.length > bestLen) {
      // File is in a subdirectory repo (submodule case) — prefer the deepest match
      best = {
        repoFullPath: asAbsolutePath(path.join(folder.path, repo)),
        repoRelativePath: repo,
        filePathInRepo: fileRelativePath.substring(repo.length + 1),
      };
      bestLen = repo.length;
    }
  }

  return best;
}

/**
 * Find which git repository an absolute file path belongs to, searching across all workspace folders.
 * @returns Repository location information, or undefined if the file isn't inside any known repo
 */
export function findRepoForAbsolutePath(
  workspaceFolders: WorkspaceFolderInfo[],
  absoluteFilePath: string,
): RepoLocationResult | undefined {
  const normalized = normalizePath(absoluteFilePath);
  for (const folder of workspaceFolders) {
    const folderNormalized = normalizePath(folder.path);
    if (!normalized.startsWith(folderNormalized + "/") && normalized !== folderNormalized) {
      continue;
    }
    const relativePath = normalized.substring(folderNormalized.length + 1);
    const result = findRepoForFile(folder, relativePath);
    if (result) {
      return result;
    }
  }
  return undefined;
}

/**
 * Returns the unique set of normalized repo paths that contain the given absolute file paths.
 * Files not belonging to any known repo are silently skipped.
 * Returns an empty array if none of the paths match a repo.
 */
export function findRepoPathsForFiles(
  workspaceFolders: WorkspaceFolderInfo[],
  absoluteFilePaths: string[],
): NormalizedRepoPath[] {
  const result = new Set<NormalizedRepoPath>();
  for (const filePath of absoluteFilePaths) {
    const repoResult = findRepoForAbsolutePath(workspaceFolders, filePath);
    if (repoResult) {
      result.add(normalizePath(repoResult.repoFullPath) as NormalizedRepoPath);
    }
  }
  return [...result];
}

/** Returns the depth of an absolute path relative to its containing workspace folder */
export function getRelativeDepth(
    absolutePath: string, 
    workspaceFolders: WorkspaceFolderInfo[]): number {
    const folder = findWorkspaceFolderForPath(asAbsolutePath(absolutePath), workspaceFolders);
    const folderDepth = folder ? folder.path.split(/[\/\\]/).filter(s => s.length > 0).length : 0;
    const itemDepth = absolutePath.split(/[\/\\]/).filter(s => s.length > 0).length;
    return itemDepth - folderDepth;
}

/** Find which workspace folder contains a given absolute file path */
export function findWorkspaceFolderForPath(
    absolutePath: AbsolutePath, 
    workspaceFolders: WorkspaceFolderInfo[]): WorkspaceFolderInfo | undefined {
    const normalizedPath = normalizePath(absolutePath);

    for (const folder of workspaceFolders) {
        const normalizedFolder = normalizePath(folder.path);
        if (normalizedPath === normalizedFolder || normalizedPath.startsWith(normalizedFolder + "/")) {
            return folder;
        }
    }

    return undefined;
}

/**
 * Converts absolute file paths to workspace-relative paths.
 * Paths that don't belong to any workspace folder are silently excluded.
 */
export function toRelativePaths(
  absolutePaths: string[],
  workspaceFolders: readonly vscode.WorkspaceFolder[],
): string[] {
  const result: string[] = [];
  for (const absPath of absolutePaths) {
    const normalized = normalizePath(absPath);
    for (const folder of workspaceFolders) {
      const folderPath = normalizePath(folder.uri.fsPath);
      if (normalized === folderPath || normalized.startsWith(folderPath + "/")) {
        result.push(normalized.substring(folderPath.length + 1));
        break;
      }
    }
  }
  return result;
}

/**
 * Converts absolute file paths to workspace-relative paths, paired with workspace names.
 * Files not matching any workspace folder fall back to the original path with an empty name,
 * preserving index alignment with the input array.
 */
export function toRelativePathsWithWorkspaceName(
  absolutePaths: string[],
  workspaceFolders: readonly vscode.WorkspaceFolder[],
): Array<{ relativePath: string; workspaceName: string }> {
  return absolutePaths.map(absPath => {
    const normalized = normalizePath(absPath);
    for (const folder of workspaceFolders) {
      const folderPath = normalizePath(folder.uri.fsPath);
      if (normalized === folderPath || normalized.startsWith(folderPath + "/")) {
        return {
          relativePath: normalized.substring(folderPath.length + 1),
          workspaceName: folder.name,
        };
      }
    }
    return { relativePath: absPath, workspaceName: "" };
  });
}

/**
 * Validate that a file path is safely within the expected root directory.
 * Prevents path traversal attacks (e.g., ../../etc/passwd).
 * @param filePath The absolute file path to validate
 * @param rootPath The root directory the file must be within
 * @returns true if the file is safely within the root, false otherwise
 */
export function isPathWithinRoot(filePath: AbsolutePath, rootPath: AbsolutePath): boolean {
    const resolvedFile = path.resolve(filePath);
    const resolvedRoot = path.resolve(rootPath);
    const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
    return resolvedFile === resolvedRoot || resolvedFile.startsWith(rootWithSep);
}
