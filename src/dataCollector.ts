import * as path from "path";
import * as vscode from "vscode";
import { AbsolutePath, asAbsolutePath } from "./pathTypes";
import { FileMetadata, WorkspaceFolderInfo } from "./types";
import { TimeWindow, isPendingChangesMode } from "./timeWindowUtils";
import { normalizePath } from "./utils";
import { log } from "./utils/logger";
import {
  collectHistoricalChanges,
  collectPendingChanges,
  discoverGitReposInSubdirs,
  isGitRepository,
} from "./git/gitOperations";

/**
 * Handles Git data collection for the Fresh File Explorer.
 * Discovers repositories and collects file metadata from Git.
 */
export class DataCollector {
  /**
   * Update fresh files for all workspace folders
   */
  static async collectAllFiles(
    workspaceFolders: WorkspaceFolderInfo[],
    currentTimeWindow: TimeWindow,
  ): Promise<{ files: Map<AbsolutePath, FileMetadata>; historicalFiles: Map<AbsolutePath, FileMetadata>; error?: string }> {
    const newFiles = new Map<AbsolutePath, FileMetadata>();
    const newHistoricalFiles = new Map<AbsolutePath, FileMetadata>();
    let errorToShow: string | undefined;

    for (const folder of workspaceFolders) {
      folder.gitRepos = [];
    }

    for (const folder of workspaceFolders) {
      const error = await DataCollector.collectFilesForFolder(folder, currentTimeWindow, newFiles, newHistoricalFiles);
      if (error && !errorToShow) {
        errorToShow = error;
      }
    }

    const totalRepos = workspaceFolders.reduce((sum, folder) => sum + folder.gitRepos.length, 0);
    log(
      `Found ${totalRepos} Git repository(ies) across ${workspaceFolders.length} workspace folder(s) with ${newFiles.size} total fresh files`,
    );

    // Update contexts for viewsWelcome
    vscode.commands.executeCommand("setContext", "freshFileExplorer.hasRepos", totalRepos > 0);
    vscode.commands.executeCommand("setContext", "freshFileExplorer.loading", false);

    return { files: newFiles, historicalFiles: newHistoricalFiles, error: errorToShow };
  }

  /**
   * Collect files for a single workspace folder
   */
  private static async collectFilesForFolder(
    folder: WorkspaceFolderInfo,
    currentTimeWindow: TimeWindow,
    targetMap: Map<AbsolutePath, FileMetadata>,
    historicalTargetMap: Map<AbsolutePath, FileMetadata>,
  ): Promise<string | undefined> {
    const rootIsGit = await isGitRepository(folder.path);

    if (rootIsGit) {
      folder.gitRepos.push("");
      return await DataCollector.collectFilesFromRepo(folder, "", currentTimeWindow, targetMap, historicalTargetMap);
    } else {
      const subRepos = await discoverGitReposInSubdirs(folder.path);
      let error: string | undefined;
      for (const repo of subRepos) {
        folder.gitRepos.push(repo);
        const repoError = await DataCollector.collectFilesFromRepo(folder, repo, currentTimeWindow, targetMap, historicalTargetMap);
        if (repoError && !error) {
          error = repoError;
        }
      }
      return error;
    }
  }

  /**
   * Collect files from a single repository
   */
  private static async collectFilesFromRepo(
    folder: WorkspaceFolderInfo,
    repoRelativePath: string,
    currentTimeWindow: TimeWindow,
    targetMap: Map<AbsolutePath, FileMetadata>,
    historicalTargetMap: Map<AbsolutePath, FileMetadata>,
  ): Promise<string | undefined> {
    const repoFullPath = repoRelativePath ? path.join(folder.path, repoRelativePath) : folder.path;
    const filesBefore = targetMap.size;
    let errorToReturn: string | undefined;

    if (isPendingChangesMode(currentTimeWindow)) {
      try {
        const files = await collectPendingChanges(repoRelativePath, repoFullPath, folder.path);
        DataCollector.addFilesToMap(folder, files, targetMap);
      } catch (error) {
        const errorMessage = String(error);
        log(
          `Failed to get pending changes from ${folder.name}/${repoRelativePath || "root"}: ${errorMessage}`,
          "error",
        );
        errorToReturn = `Error: ${errorMessage}`;
      }
    } else {
      try {
        const pendingFiles = await collectPendingChanges(repoRelativePath, repoFullPath, folder.path);
        DataCollector.addFilesToMap(folder, pendingFiles, targetMap);
      } catch (error) {
        const errorMessage = String(error);
        log(`Failed to get pending changes from ${folder.name}/${repoRelativePath || "root"}: ${errorMessage}`, "warn");
      }

      try {
        const historicalFiles = await collectHistoricalChanges(
          repoRelativePath,
          repoFullPath,
          folder.path,
          currentTimeWindow.days,
        );
        // Store historical files in the dedicated historical map (unmerged, no dedup with pending)
        DataCollector.addFilesToMap(folder, historicalFiles, historicalTargetMap);
        // Also overlay into the combined map (pending entries already there take priority)
        DataCollector.addFilesToMap(folder, historicalFiles, targetMap);
      } catch (error) {
        const errorMessage = String(error);
        if (errorMessage.includes("your current branch does not have any commits yet")) {
          log(`No commits yet in repo ${folder.name}/${repoRelativePath || "root"}`);
          if (targetMap.size === filesBefore) {
            errorToReturn = "This repository has no commits yet. Add and commit files to see them here.";
          }
        } else {
          log(
            `Failed to get historical changes from ${folder.name}/${repoRelativePath || "root"}: ${errorMessage}`,
            "warn",
          );
          if (targetMap.size === filesBefore) {
            errorToReturn = `Git error: ${errorMessage}`;
          }
        }
      }
    }

    return errorToReturn;
  }

  /**
   * Collect only pending (uncommitted) changes for all known repositories.
   * Skips repository discovery — requires gitRepos to already be populated on each folder
   * from a prior collectAllFiles() call.
   * Returns an AbsolutePath-keyed map ready to merge into freshFiles.
   */
  static async collectPendingFiles(
    workspaceFolders: WorkspaceFolderInfo[],
  ): Promise<Map<AbsolutePath, FileMetadata>> {
    const newFiles = new Map<AbsolutePath, FileMetadata>();
    for (const folder of workspaceFolders) {
      for (const repoRelativePath of folder.gitRepos) {
        const repoFullPath = repoRelativePath ? path.join(folder.path, repoRelativePath) : folder.path;
        try {
          const files = await collectPendingChanges(repoRelativePath, repoFullPath, folder.path);
          for (const [filePath, metadata] of files) {
            const absolutePath = asAbsolutePath(normalizePath(path.join(folder.path, filePath)));
            newFiles.set(absolutePath, metadata);
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
    return newFiles;
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
