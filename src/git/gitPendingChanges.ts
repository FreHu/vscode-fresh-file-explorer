import * as path from "path";
import * as fs from "fs";

import { log } from "../extension/logger";
import { FileMetadata, asCommitAuthor } from "../types";
import { ConfigService } from "../config/configService";
import { execGitWithArgs, fileExists } from "./gitOperations";
import { parseStatusZ, STATUS_Z_ARGS } from "./statusPorcelainZ";
import { streamGitDiffNumstat } from "./gitLogStream";

/**
 * Collect pending (uncommitted) changes from a git repository
 * @param repoRelativePath Path relative to workspace root (empty string for root)
 * @param repoFullPath Full filesystem path to the repository
 * @param workspaceRoot The workspace root path
 * @returns Map of file paths (relative to workspace) to file metadata
 */
export interface PendingChangesResult {
  files: Map<string, FileMetadata>;
  /** Workspace-relative paths that were renamed away and should be removed from the tree. */
  removedPaths: string[];
}

export async function collectPendingChanges(
  repoRelativePath: string,
  repoFullPath: string,
  workspaceRoot: string,
): Promise<PendingChangesResult> {
  const files = new Map<string, FileMetadata>();
  const removedPaths: string[] = [];

  // Get current user name for pending changes
  let currentUserName: string | undefined;
  try {
    const userNameOutput = await execGitWithArgs(["config", "user.name"], repoFullPath, { timeout: 1000 });
    currentUserName = userNameOutput.trim() || undefined;
  } catch (error) {
    // If we can't get the user name, leave it undefined
    log(`Could not get git user.name for pending changes: ${error}`);
  }

  log(`Executing git status in ${repoRelativePath || "root"}`);

  const output = await execGitWithArgs(STATUS_Z_ARGS, repoFullPath, { timeout: ConfigService.getGitTimeoutMs() });
  const now = new Date();

  // Collect all tracked file paths (non-untracked, non-deleted) for batch diff
  const trackedFiles: string[] = [];
  const filePathMap = new Map<string, { status: string; relativePath: string; renameSourceInRepo?: string }>();

  for (const { xy: statusCode, pathInRepo: filePath, renameSource } of parseStatusZ(output)) {
    // A path of "." or "" names the repo root itself, never a real file. Seen from a corrupt
    // index (git misreads a truncated entry table as the CWD being added/deleted) — skip rather
    // than let it render as a bogus tree row for the repo folder.
    if (filePath === "." || filePath === "./" || filePath === "") {
      continue;
    }

    // An untracked entry with a trailing slash is a *directory* git refused to descend into.
    // With `-uall`, ordinary untracked dirs are expanded to their individual files, so a surviving
    // trailing-slash entry is always a git boundary: a submodule, a nested repo, or a nested
    // worktree (e.g. `git worktree add ./feature` inside the repo). These are not files — rendering
    // them produces phantom entries like a "feate2" file under a "feate2" folder. Skip them.
    if (statusCode === "??" && filePath.endsWith("/")) {
      continue;
    }

    // A rename's old path is removed from the tree so it doesn't linger from historical data;
    // discard uses it to undo the rename. A copy's source stays.
    const renameSourceInRepo = statusCode.startsWith("R") ? renameSource : undefined;
    if (renameSourceInRepo !== undefined) {
      removedPaths.push(repoRelativePath ? repoRelativePath + "/" + renameSourceInRepo : renameSourceInRepo);
    }

    // Build full path relative to workspace root
    const fileRelativePath = repoRelativePath ? repoRelativePath + "/" + filePath : filePath;

    // Check if this is a deletion or untracked
    const isDeleted = statusCode.includes("D");
    const isUntracked = statusCode === "??";

    // Store the raw XY code (no trimming) so callers can distinguish staged-only
    // ("M ", "A ", "D ") from unstaged-only (" M", " D") and mixed ("MM", "AM", etc.)
    filePathMap.set(filePath, { status: statusCode, relativePath: fileRelativePath, renameSourceInRepo });

    // Collect tracked, non-deleted files for batch diff
    if (!isDeleted && !isUntracked) {
      trackedFiles.push(filePath);
    }
  }

  // Get line statistics for all tracked changes in one command (only if feature is enabled)
  const showLineChanges = ConfigService.getDescriptionFormat().showLineChanges;
  let numstatMap = new Map<string, { added: number; deleted: number }>();

  if (showLineChanges && trackedFiles.length > 0) {
    try {
      log(`Getting numstat for pending changes in ${repoRelativePath || "root"}`);
      numstatMap = await streamGitDiffNumstat(["diff", "--numstat", "HEAD"], repoFullPath, ConfigService.getGitTimeoutMs());
    } catch (error) {
      log(`Could not get numstat for pending changes: ${error}`, "warn");
    }
  }

  // Now create FileMetadata entries with line statistics
  for (const [filePath, fileInfo] of filePathMap) {
    const { status, relativePath, renameSourceInRepo: renameSource } = fileInfo;

    if (!files.has(relativePath)) {
      const isDeleted = status.includes("D");
      const isUntracked = status === "??";

      if (isDeleted) {
        // No file to stat, so no date; no line counts either.
        files.set(relativePath, {
          author: currentUserName ? asCommitAuthor(currentUserName) : undefined,
          status: status,
          isDeleted: true,
          isPending: true,
        });
      } else {
        // For non-deleted files, verify they exist and get their actual modification time
        const fullPath = path.join(workspaceRoot, relativePath);
        if (await fileExists(fullPath)) {
          // Get actual file modification time for proper date sorting
          let fileDate = now; // Fallback to current time
          try {
            const stats = await fs.promises.stat(fullPath);
            fileDate = stats.mtime; // Use actual file modification time
          } catch (error) {
            log(`Could not get mtime for ${relativePath}, using current time. Error: ${error}`, "warn");
          }

          let linesAdded: number | undefined;
          let linesDeleted: number | undefined;

          if (showLineChanges && isUntracked) {
            // For untracked files, count all lines as additions
            try {
              const content = await fs.promises.readFile(fullPath, "utf-8");
              const lineCount = content.split("\n").length;
              linesAdded = lineCount;
              linesDeleted = 0;
            } catch (error) {
              // If we can't read the file (binary, permission issue), skip line counts
              log(`Could not count lines for untracked file ${relativePath}. Error: ${error}`, "warn");
            }
          } else {
            // Use numstat from git diff
            const lineCounts = numstatMap.get(filePath);
            linesAdded = lineCounts?.added;
            linesDeleted = lineCounts?.deleted;
          }

          files.set(relativePath, {
            date: fileDate,
            author: currentUserName ? asCommitAuthor(currentUserName) : undefined,
            status: status,
            isDeleted: false,
            isPending: true,
            linesAdded,
            linesDeleted,
            renameSource,
          });
        }
      }
    }
  }

  return { files, removedPaths };
}
