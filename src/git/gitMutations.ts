import { log } from "../extension/logger";
import { ConfigService } from "../config/configService";
import { execGitWithArgs } from "./gitOperations";

/**
 * Discard working-tree changes to a file (restores from index for tracked files).
 * For staged-only files ("M ", "A ", etc.) this is a no-op — use discardAllFileChanges instead.
 * @param repoFullPath Full path to the git repository
 * @param filePath Relative path to the file within the repo
 * @param isUntracked Whether the file is untracked (needs clean instead of checkout)
 */
export async function discardFileChanges(
  repoFullPath: string,
  filePath: string,
  isUntracked: boolean = false,
): Promise<void> {
  if (isUntracked) {
    // For untracked files, use git clean
    const args = ["clean", "-f", "--", filePath];
    log(`Discarding untracked file: git ${args.join(" ")}`);
    await execGitWithArgs(args, repoFullPath, { timeout: ConfigService.getGitTimeoutMs() });
  } else {
    // For tracked files, use git checkout -- (restores working tree from index)
    const args = ["checkout", "-q", "--", filePath];
    log(`Discarding working-tree changes: git ${args.join(" ")}`);
    await execGitWithArgs(args, repoFullPath, { timeout: ConfigService.getGitTimeoutMs() });
  }
}

/**
 * Discard ALL changes to a file — both staged and working-tree — restoring to HEAD.
 * Use this when a file has staged changes and you want a full reset.
 * @param repoFullPath Full path to the git repository
 * @param filePath Relative path to the file within the repo
 */
export async function discardAllFileChanges(
  repoFullPath: string,
  filePath: string,
): Promise<void> {
  const args = ["restore", "--source=HEAD", "--staged", "--worktree", "--", filePath];
  log(`Discarding all changes (staged + worktree): git ${args.join(" ")}`);
  await execGitWithArgs(args, repoFullPath, { timeout: ConfigService.getGitTimeoutMs() });
}

/**
 * Fully undo a staged rename: unstage both sides, restore old file, clean up new file.
 * @param repoFullPath Full path to the git repository
 * @param newFilePath Repo-relative path of the renamed (new) file
 * @param oldFilePath Repo-relative path of the original (old) file
 */
export async function discardRename(
  repoFullPath: string,
  newFilePath: string,
  oldFilePath: string,
): Promise<void> {
  // 1. Unstage both old and new paths
  await execGitWithArgs(["restore", "--staged", "--", oldFilePath, newFilePath], repoFullPath, { timeout: ConfigService.getGitTimeoutMs() });
  // 2. Restore old file to working tree
  await execGitWithArgs(["restore", "--source=HEAD", "--worktree", "--", oldFilePath], repoFullPath, { timeout: ConfigService.getGitTimeoutMs() });
  // 3. Remove orphaned new file
  await execGitWithArgs(["clean", "-f", "--", newFilePath], repoFullPath, { timeout: ConfigService.getGitTimeoutMs() });
}

/**
 * Unstage a file's changes — moves staged changes back to the working tree.
 * Equivalent to `git restore --staged -- <file>`.
 * @param repoFullPath Full path to the git repository
 * @param filePath Relative path to the file within the repo
 */
export async function unstageFile(
  repoFullPath: string,
  filePath: string,
): Promise<void> {
  const args = ["restore", "--staged", "--", filePath];
  log(`Unstaging file: git ${args.join(" ")}`);
  await execGitWithArgs(args, repoFullPath, { timeout: ConfigService.getGitTimeoutMs() });
}
