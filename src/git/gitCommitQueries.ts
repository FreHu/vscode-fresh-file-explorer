import { log } from "../extension/logger";
import { ConfigService } from "../config/configService";
import { execGitWithArgs, execGitWithArgsBuffer, gitProbeSucceeds, decodeGitPath } from "./gitOperations";

/**
 * Get the content of a file from git history as a Buffer (for binary/non-UTF8 files)
 * @param repoFullPath Full filesystem path to the repository
 * @param filePath Path to the file relative to the repository
 * @param commitHash Optional commit hash (defaults to HEAD)
 * @returns The file content as a Buffer
 */
export async function getFileFromHistoryAsBuffer(
  repoFullPath: string,
  filePath: string,
  commitHash?: string,
): Promise<Buffer> {
  const ref = commitHash || "HEAD";
  // Use execGitWithArgsBuffer to safely handle filenames with special characters
  const args = ["show", `${ref}:${filePath}`];
  log(`Exhuming file from history (binary): git ${args.join(" ")}`);

  return await execGitWithArgsBuffer(args, repoFullPath, { timeout: ConfigService.getGitTimeoutMs() });
}

/**
 * Returns true if the file has changes staged in the index (X position of XY porcelain code).
 * Examples: "M ", "MM", "A ", "AM", "D ", "MD", "R ", "RM"
 *
 * @internal Kept here for use by fileExistsAtRef — callers should use gitStatusPredicates.ts
 */

/**
 * Returns true if `fileRelativePath` exists in the tree at `ref`.
 *
 * Uses `git cat-file -e {ref}:{path}`, which exits 0 if the blob exists and
 * non-zero otherwise. Cheaper than `ls-tree` when the answer is yes/no.
 */
export async function fileExistsAtRef(
  repoFullPath: string, ref: string, fileRelativePath: string,
): Promise<boolean> {
  return gitProbeSucceeds(["cat-file", "-e", `${ref}:${fileRelativePath}`], repoFullPath);
}

/**
 * Status codes from git diff-tree --name-status
 */
type DiffStatus = "A" | "D" | "M" | "R" | "C" | "T";

export interface CommitChange {
  status: DiffStatus;
  filePath: string;
  /** For renames/copies, the original file path */
  originalFilePath?: string;
}

/**
 * Get the list of files changed in a commit relative to its parent.
 * Uses `git diff-tree` with --name-status to also get change types.
 * For the root commit (no parent), uses --root flag.
 * @param repoFullPath Full filesystem path to the repository
 * @param commitHash The commit hash to inspect
 * @returns Array of changed files with their status
 */
export async function getCommitChanges(repoFullPath: string, commitHash: string): Promise<CommitChange[]> {
  // -r: recurse into subtrees, --no-commit-id: omit commit hash line,
  // --name-status: show status + file paths, -z: NUL-delimited output for safe parsing
  const args = ["diff-tree", "-r", "--no-commit-id", "--name-status", "--root", "-z", commitHash];
  log(`Getting commit changes: git ${args.join(" ")}`);

  const output = await execGitWithArgs(args, repoFullPath, { timeout: ConfigService.getGitTimeoutMs() });
  if (!output.trim()) {
    return [];
  }

  // With -z, fields are NUL-separated: status\0path[\0originalPath]\0status\0path...
  const parts = output.split("\0").filter(p => p !== "");
  const changes: CommitChange[] = [];

  let i = 0;
  while (i < parts.length) {
    const statusField = parts[i];
    // Status can be e.g. "M", "A", "D", "R100", "C100"
    const statusChar = statusField[0] as DiffStatus;

    if (statusChar === "R" || statusChar === "C") {
      // Rename/copy: status, original path, new path
      if (i + 2 < parts.length) {
        changes.push({
          status: statusChar,
          originalFilePath: decodeGitPath(parts[i + 1]),
          filePath: decodeGitPath(parts[i + 2]),
        });
        i += 3;
      } else {
        break;
      }
    } else {
      // Regular: status, path
      if (i + 1 < parts.length) {
        changes.push({
          status: statusChar,
          filePath: decodeGitPath(parts[i + 1]),
        });
        i += 2;
      } else {
        break;
      }
    }
  }

  return changes;
}

/**
 * Get the parent commit hash of a given commit.
 * Returns undefined for root commits (no parent).
 * @param repoFullPath Full filesystem path to the repository
 * @param commitHash The commit hash
 * @returns The parent commit hash, or undefined for root commits
 */
export async function getCommitParent(repoFullPath: string, commitHash: string): Promise<string | undefined> {
  try {
    const args = ["rev-parse", `${commitHash}^`];
    const output = await execGitWithArgs(args, repoFullPath, { timeout: 5000 });
    const parent = output.trim();
    return parent || undefined;
  } catch {
    // Root commit has no parent - rev-parse will fail
    return undefined;
  }
}

/**
 * Get the short commit message (first line) for a commit.
 */
export async function getCommitSubject(repoFullPath: string, commitHash: string): Promise<string> {
  const args = ["log", "-1", "--format=%s", commitHash];
  const output = await execGitWithArgs(args, repoFullPath, { timeout: ConfigService.getGitTimeoutMs() });
  return output.trim();
}

/**
 * Get the merge-base commit (common ancestor) between two refs.
 */
export async function getMergeBase(repoFullPath: string, ref1: string, ref2: string): Promise<string> {
  const output = await execGitWithArgs(["merge-base", ref1, ref2], repoFullPath, { timeout: ConfigService.getGitTimeoutMs() });
  return output.trim();
}

/**
 * Get the set of commit SHAs reachable from `toInclusive` but not from `fromExclusive`.
 * Equivalent to `git log --format=%H fromExclusive..toInclusive`.
 */
export async function getCommitSHAsInRange(repoFullPath: string, fromExclusive: string, toInclusive: string): Promise<Set<string>> {
  const output = await execGitWithArgs(
    ["log", "--format=%H", `${fromExclusive}..${toInclusive}`],
    repoFullPath,
    { timeout: ConfigService.getGitTimeoutMs() },
  );
  return new Set(output.split("\n").map(s => s.trim()).filter(Boolean));
}

export interface BranchInfo {
  /** Short ref name, e.g. "main" or "origin/release/1.0". */
  name: string;
  /** Human-readable relative committer date, e.g. "2 days ago". */
  relativeDate: string;
}

/**
 * Return the raw `git diff --unified=0` output for a single file between
 * `mergeBaseSha` and the **working tree** (intentionally not HEAD). The output
 * is intended to be parsed by `parseDeletedHunks` in `blameHeatmapController.ts`.
 *
 * Comparing to the working tree (rather than HEAD) means the user's "Restore
 * deleted lines" action — which inserts into the working tree without committing
 * — actually makes the deletion stop appearing in the diff. With a HEAD compare,
 * the marker would re-stamp itself on the next debounced re-apply because HEAD
 * still didn't have the lines, and the user could "restore" the same hunk
 * repeatedly, accumulating duplicates.
 *
 * Returns an empty string when the file did not exist at the merge base (all
 * new file) — the resulting empty diff produces no deletion hunks.
 */
export async function getBranchFileDeletedHunks(repoFullPath: string, mergeBaseSha: string, fileRelativePath: string): Promise<string> {
  try {
    return await execGitWithArgs(
      ["diff", "--unified=0", mergeBaseSha, "--", fileRelativePath],
      repoFullPath,
      { timeout: ConfigService.getGitTimeoutMs() },
    );
  } catch {
    // File didn't exist at mergeBase or other benign error — treat as no hunks.
    return "";
  }
}

/**
 * List all local branches, remote-tracking branches, and tags sorted by
 * most-recently-committed first. `origin/HEAD` is excluded (symref, not a real branch).
 * Tags are suffixed with " (tag)" in the description to distinguish them visually.
 */
export async function getAvailableBranches(repoFullPath: string): Promise<BranchInfo[]> {
  const output = await execGitWithArgs(
    ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)\t%(refname)\t%(committerdate:relative)", "refs/heads", "refs/remotes", "refs/tags"],
    repoFullPath,
    { timeout: ConfigService.getGitTimeoutMs() },
  );
  return output
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split("\t");
      const name = parts[0];
      const isTag = parts[1].startsWith("refs/tags/");
      const relativeDate = parts[2] ?? "";
      return { name, relativeDate: isTag ? `tag · ${relativeDate}` : relativeDate };
    })
    .filter(b => b.name && b.name !== "origin/HEAD");
}

/**
 * Returns true if the file is tracked by git (i.e. not untracked).
 * Uses `git ls-files --error-unmatch` — throws if the file is not tracked.
 */
export async function isFileTracked(repoFullPath: string, filePathInRepo: string): Promise<boolean> {
  return gitProbeSucceeds(["ls-files", "--error-unmatch", "--", filePathInRepo], repoFullPath);
}

/**
 * Run `git blame --porcelain` for the given file and return the raw output.
 * Throws if git blame fails (e.g. empty repo or git error).
 */
export async function runGitBlamePorcelain(repoFullPath: string, filePathInRepo: string): Promise<string> {
  return execGitWithArgs(
    ["blame", "--porcelain", "--", filePathInRepo],
    repoFullPath,
    { timeout: ConfigService.getGitTimeoutMs() },
  );
}

