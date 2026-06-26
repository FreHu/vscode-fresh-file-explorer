import * as path from "path";
import { AbsolutePath, asAbsolutePath, NormalizedRepoPath, asNormalizedRepoPath } from "../pathTypes";
import { CommitStats, FileMetadata, WorkspaceFolderInfo } from "../types";
import { normalizePath } from "../utils";
import { log } from "../extension/logger";
import {
  collectHistoricalChanges,
  collectPendingChanges,
  discoverGitReposInSubdirs,
  isGitRepository,
  isGitRepositoryRoot,
  readGitModulesSubmodulePaths,
} from "../git/gitOperations";

/** Fully-resolved information about a single Git repository within a workspace folder. */
export interface RepoInfo {
  folder: WorkspaceFolderInfo;
  repoRelPath: string;
  repoFullPath: string;
  normalizedRepoPath: NormalizedRepoPath;
  /** True when this repo was discovered as a git submodule of another repo. */
  isSubmodule?: boolean;
  /**
   * True when this is a submodule declared in .gitmodules but not checked out
   * (empty working dir). Such entries must NOT be scanned — git would resolve
   * the empty dir to the superproject — so they are kept only for display.
   */
  isUninitialized?: boolean;
}

/**
 * Handles Git data collection for the Fresh File Explorer.
 * Discovers repositories and collects file metadata from Git.
 */
export class DataCollector {
  /**
   * Discover all Git repositories across workspace folders.
   * Populates `folder.gitRepos` for each folder without loading any files.
   *
   * Also returns `brokenWorktrees`: absolute paths of directories that look like git worktrees
   * but whose gitdir pointer git no longer accepts (typically after the working tree was moved).
   * They don't load as repos; the caller surfaces them so the degraded setup isn't silent.
   */
  static async discoverAllRepos(workspaceFolders: WorkspaceFolderInfo[]): Promise<{ repos: RepoInfo[]; brokenWorktrees: AbsolutePath[] }> {
    const result: RepoInfo[] = [];
    const brokenWorktrees: AbsolutePath[] = [];
    for (const folder of workspaceFolders) {
      const rootIsGit = await isGitRepository(folder.path);
      const discovered = rootIsGit
        ? { repos: [""], brokenWorktrees: [] }
        : await discoverGitReposInSubdirs(folder.path);
      for (const brokenRelPath of discovered.brokenWorktrees) {
        brokenWorktrees.push(asAbsolutePath(path.join(folder.path, brokenRelPath)));
      }
      for (const repoRelPath of discovered.repos) {
        const repoFullPath = repoRelPath ? path.join(folder.path, repoRelPath) : folder.path;
        result.push({ folder, repoRelPath, repoFullPath, normalizedRepoPath: asNormalizedRepoPath(repoFullPath) });
        await DataCollector.collectSubmoduleRepos(folder, repoFullPath, repoRelPath, result);
      }
    }
    return { repos: result, brokenWorktrees };
  }

  /**
   * Recursively discover submodules within a repo and append them as
   * top-level RepoInfo entries. Uninitialized (not-checked-out) submodules are
   * recorded with `isUninitialized: true` so the UI can show they exist, but
   * are never scanned — see RepoInfo.isUninitialized.
   */
  private static async collectSubmoduleRepos(
    folder: WorkspaceFolderInfo,
    repoFullPath: string,
    repoRelPath: string,
    result: RepoInfo[],
  ): Promise<void> {
    const submodulePaths = await readGitModulesSubmodulePaths(repoFullPath);
    for (const submoduleRelPath of submodulePaths) {
      const submoduleFullPath = path.join(repoFullPath, submoduleRelPath);
      const submoduleRepoRelPath = repoRelPath ? `${repoRelPath}/${submoduleRelPath}` : submoduleRelPath;
      const isInitialized = await isGitRepositoryRoot(submoduleFullPath);
      if (!isInitialized) {
        // Record for display only; do not scan and do not recurse (no .git to read).
        log(`Uninitialized submodule (display only): ${submoduleRepoRelPath}`);
        result.push({
          folder,
          repoRelPath: submoduleRepoRelPath,
          repoFullPath: submoduleFullPath,
          normalizedRepoPath: asNormalizedRepoPath(submoduleFullPath),
          isSubmodule: true,
          isUninitialized: true,
        });
        continue;
      }
      result.push({
        folder,
        repoRelPath: submoduleRepoRelPath,
        repoFullPath: submoduleFullPath,
        normalizedRepoPath: asNormalizedRepoPath(submoduleFullPath),
        isSubmodule: true,
      });

      // Recurse to discover nested submodules
      await DataCollector.collectSubmoduleRepos(folder, submoduleFullPath, submoduleRepoRelPath, result);
    }
  }

  /**
   * Collect only the pending (uncommitted) changes for a single repository.
   */
  static async collectPendingForRepo(
    folder: WorkspaceFolderInfo,
    repoRelativePath: string,
    targetMap: Map<AbsolutePath, FileMetadata>,
  ): Promise<void> {
    const repoFullPath = repoRelativePath ? path.join(folder.path, repoRelativePath) : folder.path;
    try {
      const { files } = await collectPendingChanges(repoRelativePath, repoFullPath, folder.path);
      DataCollector.addFilesToMap(folder, files, targetMap);
    } catch (error) {
      log(`Failed to get pending changes from ${folder.name}/${repoRelativePath || "root"}: ${String(error)}`, "warn");
    }
  }

  /**
   * Collect only the historical (committed) changes for a single repository.
   *
   * @param maxDays          The maximum number of days to load from git log.
   * @param thresholds       Optional sorted-ascending day values at which incremental
   *                         tree updates should fire via `onThresholdCrossed`.
   * @param onThresholdCrossed Called with a partial AbsolutePath-keyed map each time
   *                           the git log stream crosses a threshold boundary.
   */
  static async collectHistoricalForRepo(
    folder: WorkspaceFolderInfo,
    repoRelativePath: string,
    maxDays: number,
    targetMap: Map<AbsolutePath, FileMetadata>,
    historicalTargetMap: Map<AbsolutePath, FileMetadata>,
    pathspec?: string,
    thresholds?: number[],
    onThresholdCrossed?: (days: number, partial: Map<AbsolutePath, FileMetadata>) => void,
    commitStatsMap?: Map<string, CommitStats>,
  ): Promise<{ error: { message: string; isPathspecError: boolean } | undefined; fullData: Map<AbsolutePath, FileMetadata> }> {
    const repoFullPath = repoRelativePath ? path.join(folder.path, repoRelativePath) : folder.path;
    const filesBefore = targetMap.size;

    // Wrap the caller's onThresholdCrossed to convert workspace-relative paths to AbsolutePaths.
    const wrappedOnThreshold = onThresholdCrossed
      ? (days: number, partial: Map<string, FileMetadata>) => {
          const absoluteMap = new Map<AbsolutePath, FileMetadata>();
          for (const [filePath, metadata] of partial) {
            absoluteMap.set(asAbsolutePath(normalizePath(path.join(folder.path, filePath))), metadata);
          }
          onThresholdCrossed(days, absoluteMap);
        }
      : undefined;

    try {
      const historicalFiles = await collectHistoricalChanges(
        repoRelativePath,
        repoFullPath,
        folder.path,
        maxDays,
        pathspec,
        thresholds,
        wrappedOnThreshold,
        commitStatsMap,
      );
      DataCollector.addFilesToMap(folder, historicalFiles, historicalTargetMap);
      DataCollector.addFilesToMap(folder, historicalFiles, targetMap);

      // Build the per-repo AbsolutePath-keyed map for caching.
      const fullData = new Map<AbsolutePath, FileMetadata>();
      for (const [filePath, metadata] of historicalFiles) {
        fullData.set(asAbsolutePath(normalizePath(path.join(folder.path, filePath))), metadata);
      }
      return { error: undefined, fullData };
    } catch (error) {
      const errorMessage = String(error);
      // no commits is fine - we'll end up showing "no fresh files" (or there might be pending changes)
      if (!errorMessage.includes("does not have any commits yet")) {
        log(
          `Failed to get historical changes from ${folder.name}/${repoRelativePath || "root"}: ${errorMessage}`,
          "warn",
        );
        if (targetMap.size === filesBefore) {
          return {
            error: { message: `Git error: ${errorMessage}`, isPathspecError: pathspec !== undefined },
            fullData: new Map(),
          };
        }
      }
    }
    return { error: undefined, fullData: new Map() };
  }

  /**
   * Collect only pending (uncommitted) changes for all known repositories.
   * Skips repository discovery — requires gitRepos to already be populated on each folder
   * from a prior discoverAllRepos() call.
   * Returns pending files and absolute paths that should be removed (rename sources).
   */
  static async collectPendingFiles(
    workspaceFolders: WorkspaceFolderInfo[],
  ): Promise<{ files: Map<AbsolutePath, FileMetadata>; removedPaths: AbsolutePath[] }> {
    const newFiles = new Map<AbsolutePath, FileMetadata>();
    const allRemovedPaths: AbsolutePath[] = [];
    for (const folder of workspaceFolders) {
      for (const repoRelativePath of folder.gitRepos) {
        const repoFullPath = repoRelativePath ? path.join(folder.path, repoRelativePath) : folder.path;
        try {
          const { files, removedPaths } = await collectPendingChanges(repoRelativePath, repoFullPath, folder.path);
          for (const [filePath, metadata] of files) {
            const absolutePath = asAbsolutePath(normalizePath(path.join(folder.path, filePath)));
            newFiles.set(absolutePath, metadata);
          }
          for (const removedPath of removedPaths) {
            allRemovedPaths.push(asAbsolutePath(normalizePath(path.join(folder.path, removedPath))));
          }
          log(`Collected ${files.size} pending file(s) from ${folder.name}/${repoRelativePath || "root"}`);
        } catch (error) {
          log(
            `Failed to get pending changes from ${folder.name}/${repoRelativePath || "root"}: ${String(error)}`,
            "warn",
          );
        }
      }
    }
    return { files: newFiles, removedPaths: allRemovedPaths };
  }

  /**
   * Add files from a collection to target map, avoiding duplicates
   */
  private static addFilesToMap(
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
}
