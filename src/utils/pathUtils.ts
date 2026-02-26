import * as path from "path";
import { AbsolutePath, asAbsolutePath } from "../pathTypes";
import { WorkspaceFolderInfo } from "../types";
import { normalizePath } from "../utils";

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