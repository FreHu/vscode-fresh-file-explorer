import { normalizePath } from "./utils";

/**
 * Branded type for absolute file system paths
 * Used to distinguish absolute paths from relative paths at compile time
 */
export type AbsolutePath = string & { readonly __brand: "absolute" };

/**
 * Branded type for relative file system paths
 * Used to distinguish relative paths from absolute paths at compile time
 */
export type RelativePath = string & { readonly __brand: "relative" };

/**
 * Type guard to check if a path is absolute
 */
export function isAbsolutePath(path: string): path is AbsolutePath {
  // Windows: C:\ or \\server\share
  // Unix: /
  return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(path);
}

/**
 * Cast a string to AbsolutePath, automatically normalizing path separators to forward slashes
 */
export function asAbsolutePath(path: string): AbsolutePath {
  return normalizePath(path) as AbsolutePath;
}

/**
 * Branded type for normalized (forward-slash) absolute paths to git repository roots.
 */
export type NormalizedRepoPath = string & { readonly __brand: "normalizedRepo" };

/**
 * Cast a string to NormalizedRepoPath, normalizing path separators to forward slashes.
 */
export function asNormalizedRepoPath(path: string): NormalizedRepoPath {
  return normalizePath(path) as NormalizedRepoPath;
}

/**
 * Cast a string to RelativePath
 */
export function asRelativePath(path: string): RelativePath {
  return path as RelativePath;
}
