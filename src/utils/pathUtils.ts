import * as path from "path";
import * as vscode from "vscode";
import { AbsolutePath, asAbsolutePath } from "../pathTypes";
import { WorkspaceFolderInfo } from "../types";
import { normalizePath } from "../utils";

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
): string[] {
  const result = new Set<string>();
  for (const filePath of absoluteFilePaths) {
    const repoResult = findRepoForAbsolutePath(workspaceFolders, filePath);
    if (repoResult) {
      result.add(normalizePath(repoResult.repoFullPath));
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

/**
 * Returns the absolute path of the parent directory of a file within its workspace folder,
 * or undefined if the file is already at the root of the workspace folder.
 */
export function getParentPathWithinWorkspace(absolutePath: string, workspaceFolderPath: string): string | undefined {
    const relativePath = normalizePath(path.relative(workspaceFolderPath, absolutePath));
    const lastSlash = relativePath.lastIndexOf("/");
    if (lastSlash === -1) {
        return undefined;
    }
    return path.join(workspaceFolderPath, relativePath.substring(0, lastSlash));
}