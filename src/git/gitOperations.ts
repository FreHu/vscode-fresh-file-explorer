import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";

import { log } from "../utils/logger";
import { CommitData, FileMetadata, asCommitAuthor, asCommitHash, asCommitMessage } from "../types";
import { AbsolutePath, asAbsolutePath } from "../pathTypes";
import { ConfigService } from "../config/configService";

const gitPathDecoder = new TextDecoder("utf-8");
const gitPathEncoder = new TextEncoder();

/**
 * Execute a git command with arguments safely (no shell interpolation).
 * This is CRITICAL for security - avoids shell injection from filenames.
 * @param args Array of git arguments (e.g., ['show', 'HEAD:file.txt'])
 * @param cwd The working directory
 * @param options Optional settings: timeout (ms)
 * @returns The command output as a string
 */
export function execGitWithArgs(args: string[], cwd: string, options: { timeout?: number } = {}): Promise<string> {
  const { timeout } = options;
  return new Promise((resolve, reject) => {
    const child = cp.spawn("git", args, { cwd, timeout });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", data => {
      stderr += data.toString();
    });

    child.on("error", error => {
      reject(error.message);
    });

    child.on("close", code => {
      if (code !== 0) {
        reject(stderr || `git exited with code ${code}`);
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Execute a git command with arguments safely, returning Buffer (for binary files).
 * This is CRITICAL for security - avoids shell injection from filenames.
 * @param args Array of git arguments
 * @param cwd The working directory
 * @param options Optional settings: timeout (ms)
 * @returns The command output as a Buffer
 */
export function execGitWithArgsBuffer(
  args: string[],
  cwd: string,
  options: { timeout?: number } = {},
): Promise<Buffer> {
  const { timeout } = options;
  return new Promise((resolve, reject) => {
    const child = cp.spawn("git", args, { cwd, timeout });
    const chunks: Buffer[] = [];
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      chunks.push(Buffer.from(data));
    });

    child.stderr.on("data", data => {
      stderr += data.toString();
    });

    child.on("error", error => {
      reject(error.message);
    });

    child.on("close", code => {
      if (code !== 0) {
        reject(stderr || `git exited with code ${code}`);
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
  });
}

/**
 * Decode a git path that may be quoted and contain octal escape sequences.
 * Git quotes paths with special characters and escapes unicode as octal (e.g., \303\261 for ñ).
 * @param gitPath The path from git output
 * @returns The decoded path
 */
export function decodeGitPath(gitPath: string): string {
  // Remove surrounding quotes if present
  if (gitPath.startsWith('"') && gitPath.endsWith('"')) {
    gitPath = gitPath.slice(1, -1);
  }

  // No backslash -> no octal escapes — should be most cases
  if (!gitPath.includes("\\")) {
    return gitPath;
  }

  // Decode octal escape sequences (e.g., \303\261 -> bytes -> UTF-8 string)
  // Git escapes non-ASCII bytes as \NNN octal sequences
  const bytes: number[] = [];
  let i = 0;
  while (i < gitPath.length) {
    if (gitPath[i] === "\\" && i + 3 < gitPath.length) {
      // Check if this is an octal escape (\NNN where N is 0-7)
      const octal = gitPath.substring(i + 1, i + 4);
      if (/^[0-7]{3}$/.test(octal)) {
        bytes.push(parseInt(octal, 8));
        i += 4;
        continue;
      }
    }
    // Regular character - convert to byte(s)
    const char = gitPath.charCodeAt(i);
    if (char < 128) {
      bytes.push(char);
    } else {
      // Multi-byte UTF-8 character that wasn't escaped (shouldn't happen, but handle it)
      const encoded = gitPathEncoder.encode(gitPath[i]);
      bytes.push(...encoded);
    }
    i++;
  }

  // Decode the bytes as UTF-8
  return gitPathDecoder.decode(new Uint8Array(bytes));
}

/**
 * Execute a git command in a specific directory
 * @param command The git command to execute
 * @param cwd The working directory
 * @param options Optional settings: maxBuffer, timeout (ms), signal for cancellation
 */
export function execGitInDir(
  command: string,
  cwd: string,
  options: { maxBuffer?: number; timeout?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const { maxBuffer = 50 * 1024 * 1024, timeout, signal } = options;
  return new Promise((resolve, reject) => {
    const child = cp.exec(command, { cwd, maxBuffer, timeout }, (error, stdout, stderr) => {
      if (error) {
        if (error.killed) {
          reject("Git operation timed out");
        } else {
          const errorMsg = stderr || error.message;
          reject(errorMsg);
        }
        return;
      }
      resolve(stdout);
    });

    // Support cancellation via AbortSignal
    if (signal) {
      signal.addEventListener("abort", () => {
        child.kill();
        reject("Git operation cancelled");
      });
    }
  });
}

/**
 * Execute a git command and return raw buffer (for binary files)
 * @param command The git command to execute
 * @param cwd The working directory
 * @param options Optional settings: maxBuffer, timeout (ms), signal for cancellation
 */
export function execGitInDirBuffer(
  command: string,
  cwd: string,
  options: { maxBuffer?: number; timeout?: number; signal?: AbortSignal } = {},
): Promise<Buffer> {
  const { maxBuffer = 50 * 1024 * 1024, timeout, signal } = options;
  return new Promise((resolve, reject) => {
    const child = cp.exec(command, { cwd, maxBuffer, timeout, encoding: "buffer" }, (error, stdout, stderr) => {
      if (error) {
        if (error.killed) {
          reject("Git operation timed out");
        } else {
          const errorMsg = stderr?.toString() || error.message;
          reject(errorMsg);
        }
        return;
      }
      resolve(stdout as Buffer);
    });

    // Support cancellation via AbortSignal
    if (signal) {
      signal.addEventListener("abort", () => {
        child.kill();
        reject("Git operation cancelled");
      });
    }
  });
}

/**
 * Check if a directory is a git repository
 */
export async function isGitRepository(dirPath: string): Promise<boolean> {
  try {
    await execGitInDir("git rev-parse --git-dir", dirPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a file exists on disk
 */
export function fileExists(filePath: string): Promise<boolean> {
  return new Promise(resolve => {
    fs.access(filePath, fs.constants.F_OK, err => {
      resolve(!err);
    });
  });
}

/**
 * Discover git repositories in subdirectories of a path, recursing into non-repo directories.
 * Stops recursing once a git repository is found (repos inside repos are not considered).
 * @param rootPath The directory to scan
 * @param relativePrefix Internal: the path prefix accumulated during recursion (forward-slash separated)
 */
export async function discoverGitReposInSubdirs(rootPath: string, relativePrefix: string = ""): Promise<string[]> {
  const repos: string[] = [];

  try {
    const entries = await fs.promises.readdir(rootPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        const subDirPath = path.join(rootPath, entry.name);
        const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
        const isGit = await isGitRepository(subDirPath);

        if (isGit) {
          log(`Found Git repository in subdirectory: ${relativePath}`);
          repos.push(relativePath);
        } else {
          // Not a git repo — recurse deeper to find nested repos
          const nested = await discoverGitReposInSubdirs(subDirPath, relativePath);
          repos.push(...nested);
        }
      }
    }
  } catch (error) {
    log(`Error scanning subdirectories: ${error}`, "error");
  }

  return repos;
}

export interface RepoInfo {
  name: string;
  path: AbsolutePath;
}

/**
 * Expand a list of workspace folders into the actual git repositories they
 * contain. If the folder root itself is a git repo it is used directly;
 * otherwise subdirectories are scanned recursively.
 */
export async function discoverReposInWorkspace(
  folders: readonly vscode.WorkspaceFolder[],
  totalFolders: number,
): Promise<RepoInfo[]> {
  const repos: RepoInfo[] = [];

  for (const folder of folders) {
    const folderPath = folder.uri.fsPath;
    const rootIsGit = await isGitRepository(folderPath);

    if (rootIsGit) {
      repos.push({ name: folder.name, path: asAbsolutePath(folderPath) });
    } else {
      const subRepos = await discoverGitReposInSubdirs(folderPath);
      for (const repoRelPath of subRepos) {
        const repoFullPath = asAbsolutePath(`${folderPath}/${repoRelPath}`);
        const repoName = totalFolders > 1 ? `${folder.name}/${repoRelPath}` : repoRelPath;
        repos.push({ name: repoName, path: repoFullPath });
      }
    }
  }

  return repos;
}

/**
 * Collect pending (uncommitted) changes from a git repository
 * @param repoRelativePath Path relative to workspace root (empty string for root)
 * @param repoFullPath Full filesystem path to the repository
 * @param workspaceRoot The workspace root path
 * @returns Map of file paths (relative to workspace) to file metadata
 */
export async function collectPendingChanges(
  repoRelativePath: string,
  repoFullPath: string,
  workspaceRoot: string,
): Promise<Map<string, FileMetadata>> {
  const files = new Map<string, FileMetadata>();

  // Get current user name for pending changes
  let currentUserName: string | undefined;
  try {
    const userNameOutput = await execGitInDir("git config user.name", repoFullPath, { timeout: 1000 });
    currentUserName = userNameOutput.trim() || undefined;
  } catch (error) {
    // If we can't get the user name, leave it undefined
    log(`Could not get git user.name for pending changes: ${error}`);
  }

  // Get all modified, added, deleted, and untracked files using git status
  // --porcelain gives machine-readable output
  // -uall shows individual untracked files (not just directories)
  const gitCommand = "git status --porcelain -uall";
  log(`Executing git status in ${repoRelativePath || "root"}`);

  const output = await execGitInDir(gitCommand, repoFullPath, { timeout: ConfigService.getGitTimeoutMs() });
  const lines = output.split("\n").filter(line => line.length > 0);
  const now = new Date();

  // Collect all tracked file paths (non-untracked, non-deleted) for batch diff
  const trackedFiles: string[] = [];
  const filePathMap = new Map<string, { status: string; relativePath: string }>();

  for (const line of lines) {
    // Format: XY filename (where XY is the status code)
    // Examples: " M file.txt", "?? newfile.txt", "A  staged.txt", "MM both.txt", " D deleted.txt"
    if (line.length < 4) {
      continue;
    }

    const statusCode = line.substring(0, 2);
    let filePath = decodeGitPath(line.substring(3));

    // Handle renamed files: "R  old -> new"
    if (statusCode.startsWith("R")) {
      const arrowIndex = filePath.indexOf(" -> ");
      if (arrowIndex !== -1) {
        filePath = filePath.substring(arrowIndex + 4);
      }
    }

    // Build full path relative to workspace root
    const fileRelativePath = repoRelativePath ? repoRelativePath + "/" + filePath : filePath;

    // Check if this is a deletion or untracked
    const isDeleted = statusCode.includes("D");
    const isUntracked = statusCode.trim() === "??";

    filePathMap.set(filePath, { status: statusCode.trim() || "??", relativePath: fileRelativePath });

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
    const { status, relativePath } = fileInfo;

    if (!files.has(relativePath)) {
      const isDeleted = status.includes("D");
      const isUntracked = status === "??";

      if (isDeleted) {
        // For deleted files, we don't check if file exists (it won't!) and skip line counts
        files.set(relativePath, {
          date: now,
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
          });
        }
      }
    }
  }

  return files;
}

/**
 * Stateful line processor for `git log --name-status` output.
 * Calls `onFileEntry` for every file entry parsed, passing the workspace-relative
 * path, the git status code, and the enclosing commit.
 * Extracted for testability — both `parseGitLogNameStatus` and
 * `streamGitLogNameStatus` use this.
 */
function createNameStatusLineProcessor(
  repoRelativePath: string,
  onFileEntry: (relativePath: string, status: string, commit: CommitData) => void,
): (line: string) => void {
  let currentCommit: CommitData | null = null;

  return function processLine(rawLine: string) {
    const line = rawLine.trim();
    if (line.startsWith("__COMMIT__")) {
      const parts = line.substring("__COMMIT__".length).split("|");
      if (parts.length >= 4) {
        currentCommit = {
          hash: asCommitHash(parts[0]),
          author: asCommitAuthor(parts[1]),
          date: new Date(parts[2]),
          message: asCommitMessage(parts.slice(3).join("|")),
        };
      }
      return;
    }

    if (line.length === 0 || !currentCommit) {
      return;
    }

    // Format: <status>\t<filename>
    // Renames/copies: R100\t<old>\t<new>  or  C100\t<src>\t<dst>
    const tabIndex = line.indexOf("\t");
    if (tabIndex === -1) {
      return;
    }

    const status = line.substring(0, tabIndex);
    let fileName: string;

    if (status.startsWith("R") || status.startsWith("C")) {
      const rest = line.substring(tabIndex + 1);
      const secondTab = rest.indexOf("\t");
      // Use the NEW path (destination) for renames/copies
      fileName = secondTab !== -1
        ? decodeGitPath(rest.substring(secondTab + 1))
        : decodeGitPath(rest);
    } else {
      fileName = decodeGitPath(line.substring(tabIndex + 1));
    }

    const fileRelativePath = repoRelativePath ? repoRelativePath + "/" + fileName : fileName;
    onFileEntry(fileRelativePath, status, currentCommit);
  };
}

/**
 * Parse raw `git log --name-status` text into a map of file paths to their
 * most-recent (first-seen) commit info.
 * Pure function with no I/O — suitable for unit testing.
 *
 * @param raw              Full text output from git.
 * @param repoRelativePath Repo root relative to workspace root (empty for root repo).
 */
export function parseGitLogNameStatus(
  raw: string,
  repoRelativePath: string,
): Map<string, { status: string; commit: CommitData }> {
  const fileStatusMap = new Map<string, { status: string; commit: CommitData }>();
  const processLine = createNameStatusLineProcessor(repoRelativePath, (relativePath, status, commit) => {
    if (!fileStatusMap.has(relativePath)) {
      fileStatusMap.set(relativePath, { status, commit });
    }
  });
  for (const line of raw.split("\n")) {
    processLine(line);
  }
  return fileStatusMap;
}

/**
 * Execute `git log --name-status` and stream/parse output line-by-line.
 * Avoids buffering the entire output in memory, which can reach 10+ MB on
 * large repositories.
 */
/**
 * Spawn `git` with the given args and call `onLine` for every complete line of
 * stdout output. Handles the line-buffer split, stderr collection, error and
 * close events uniformly so individual streaming functions only need to supply
 * the per-line processing logic.
 */
function spawnGitLines(
  args: string[],
  cwd: string,
  timeout: number | undefined,
  onLine: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn("git", args, { cwd, timeout });
    let buffer = "";

    child.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        onLine(line);
      }
    });

    let stderr = "";
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("error", (error) => {
      reject(error.message);
    });

    child.on("close", (code) => {
      if (buffer.trim()) {
        onLine(buffer);
      }
      if (code !== 0) {
        reject(stderr || `git exited with code ${code}`);
      } else {
        resolve();
      }
    });
  });
}

export function streamGitLogNameStatus(
  args: string[],
  cwd: string,
  repoRelativePath: string,
  timeout: number | undefined,
): Promise<Map<string, { status: string; commit: CommitData }>> {
  const fileStatusMap = new Map<string, { status: string; commit: CommitData }>();
  const processLine = createNameStatusLineProcessor(repoRelativePath, (relativePath, status, commit) => {
    if (!fileStatusMap.has(relativePath)) {
      fileStatusMap.set(relativePath, { status, commit });
    }
  });
  return spawnGitLines(args, cwd, timeout, processLine).then(() => fileStatusMap);
}

/**
 * Stateful line processor for `git log --numstat` output.
 * Skips `__COMMIT__` header lines; calls onEntry for data lines.
 */
function createNumstatLineProcessor(
  repoRelativePath: string,
  onEntry: (relativePath: string, added: number, deleted: number) => void,
): (line: string) => void {
  return function processLine(rawLine: string) {
    const line = rawLine.trim();
    if (!line || line.startsWith("__COMMIT__")) {
      return;
    }
    const parts = line.split("\t");
    if (parts.length !== 3) {
      return;
    }
    const [additions, deletions, filePath] = parts;
    if (additions === "-" || deletions === "-") {
      return; // binary
    }
    const added = parseInt(additions, 10);
    const deleted = parseInt(deletions, 10);
    if (isNaN(added) || isNaN(deleted)) {
      return;
    }
    const fileName = decodeGitPath(filePath);
    const fileRelativePath = repoRelativePath ? repoRelativePath + "/" + fileName : fileName;
    onEntry(fileRelativePath, added, deleted);
  };
}

/** Pure parse of `git log --numstat` output. Workspace-relative keys, first-wins dedup. */
export function parseGitLogNumstat(
  raw: string,
  repoRelativePath: string,
): Map<string, { added: number; deleted: number }> {
  const map = new Map<string, { added: number; deleted: number }>();
  const processLine = createNumstatLineProcessor(repoRelativePath, (rel, added, deleted) => {
    if (!map.has(rel)) {
      map.set(rel, { added, deleted });
    }
  });
  for (const line of raw.split("\n")) {
    processLine(line);
  }
  return map;
}

/** Streaming `git log --numstat`. Workspace-relative keys, first-wins dedup. */
export function streamGitLogNumstat(
  args: string[],
  cwd: string,
  repoRelativePath: string,
  timeout: number | undefined,
): Promise<Map<string, { added: number; deleted: number }>> {
  const map = new Map<string, { added: number; deleted: number }>();
  const processLine = createNumstatLineProcessor(repoRelativePath, (rel, added, deleted) => {
    if (!map.has(rel)) {
      map.set(rel, { added, deleted });
    }
  });
  return spawnGitLines(args, cwd, timeout, processLine).then(() => map);
}

/** Pure parse of `git diff --numstat` output (no commit headers). Repo-relative keys. */
export function parseGitDiffNumstat(raw: string): Map<string, { added: number; deleted: number }> {
  const map = new Map<string, { added: number; deleted: number }>();
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const parts = line.split("\t");
    if (parts.length !== 3) {
      continue;
    }
    const [additions, deletions, filePath] = parts;
    if (additions === "-" || deletions === "-") {
      continue; // binary
    }
    const added = parseInt(additions, 10);
    const deleted = parseInt(deletions, 10);
    if (isNaN(added) || isNaN(deleted)) {
      continue;
    }
    const fileName = decodeGitPath(filePath);
    if (!map.has(fileName)) {
      map.set(fileName, { added, deleted });
    }
  }
  return map;
}

/** Streaming `git diff --numstat`. Repo-relative keys. */
export function streamGitDiffNumstat(
  args: string[],
  cwd: string,
  timeout: number | undefined,
): Promise<Map<string, { added: number; deleted: number }>> {
  const map = new Map<string, { added: number; deleted: number }>();
  const processLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line) {
      return;
    }
    const parts = line.split("\t");
    if (parts.length !== 3) {
      return;
    }
    const [additions, deletions, filePath] = parts;
    if (additions === "-" || deletions === "-") {
      return; // binary
    }
    const added = parseInt(additions, 10);
    const deleted = parseInt(deletions, 10);
    if (isNaN(added) || isNaN(deleted)) {
      return;
    }
    const fileName = decodeGitPath(filePath);
    if (!map.has(fileName)) {
      map.set(fileName, { added, deleted });
    }
  };
  return spawnGitLines(args, cwd, timeout, processLine).then(() => map);
}

/**
 * Collect historical changes from git log within a time window
 * @param repoRelativePath Path relative to workspace root (empty string for root)
 * @param repoFullPath Full filesystem path to the repository
 * @param workspaceRoot The workspace root path
 * @param days Number of days to look back
 * @returns Map of file paths (relative to workspace) to file metadata including commit info
 */
export async function collectHistoricalChanges(
  repoRelativePath: string,
  repoFullPath: string,
  workspaceRoot: string,
  days: number,
): Promise<Map<string, FileMetadata>> {
  const files = new Map<string, FileMetadata>();

  const sinceDate = `${days}.days.ago`;

  // Step 1: Get file statuses using --name-status (streamed to avoid buffering 10+ MB)
  const statusArgs = ["log", `--since=${sinceDate}`, "--name-status", "--pretty=format:__COMMIT__%h|%an|%aI|%s"];
  log(`Executing git command for status in ${repoRelativePath || "root"}: git ${statusArgs.join(" ")}`);

  const fileStatusMap = await streamGitLogNameStatus(statusArgs, repoFullPath, repoRelativePath, ConfigService.getGitTimeoutMs());

  // Step 2: Get line counts using --numstat (only if feature is enabled)
  const showLineChanges = ConfigService.getDescriptionFormat().showLineChanges;
  let lineCountsMap = new Map<string, { added: number; deleted: number }>();

  if (showLineChanges) {
    const numstatArgs = ["log", `--since=${sinceDate}`, "--numstat", "--pretty=format:__COMMIT__%h|%an|%aI|%s"];
    log(`Executing git command for numstat in ${repoRelativePath || "root"}: git ${numstatArgs.join(" ")}`);
    lineCountsMap = await streamGitLogNumstat(numstatArgs, repoFullPath, repoRelativePath, ConfigService.getGitTimeoutMs());
  }

  // Step 3: Merge status and line counts
  const fileStatusEntries = Array.from(fileStatusMap.entries());

  // ideally look into an approach that avoids having to do this check
  // but need to look into edge cases around detecting deletes
  const existsResults = await Promise.all(
    fileStatusEntries.map(
      ([fileRelativePath]) => fileExists(path.join(workspaceRoot, fileRelativePath)))
  );

  for (let i = 0; i < fileStatusEntries.length; i++) {
    const [fileRelativePath, statusInfo] = fileStatusEntries[i];
    const existsOnDisk = existsResults[i];
    const isDeleted = statusInfo.status === "D";

    // Include the file if:
    // 1. It exists on disk (normal case)
    // 2. It was deleted in this commit and still doesn't exist (historical deletion)
    if (existsOnDisk || isDeleted) {
      const lineCounts = lineCountsMap.get(fileRelativePath);

      files.set(fileRelativePath, {
        date: statusInfo.commit.date,
        author: statusInfo.commit.author,
        commitHash: statusInfo.commit.hash,
        commitMessage: statusInfo.commit.message,
        status: statusInfo.status,
        isDeleted: !existsOnDisk,
        isPending: false,
        linesAdded: lineCounts?.added,
        linesDeleted: lineCounts?.deleted,
      });
    }
  }

  return files;
}

/**
 * Get the content of a file from git history
 * @param repoFullPath Full filesystem path to the repository
 * @param filePath Path to the file relative to the repository
 * @param commitHash Optional commit hash (defaults to HEAD)
 * @returns The file content as a string
 */
export async function getFileFromHistory(repoFullPath: string, filePath: string, commitHash?: string): Promise<string> {
  const ref = commitHash || "HEAD";
  // Use execGitWithArgs to safely handle filenames with special characters
  const args = ["show", `${ref}:${filePath}`];
  log(`Exhuming file from history: git ${args.join(" ")}`);

  return await execGitWithArgs(args, repoFullPath);
}

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

  return await execGitWithArgsBuffer(args, repoFullPath);
}

/**
 * Discard changes to a file (git checkout -- <file> for tracked, rm for untracked)
 * @param repoFullPath Full path to the git repository
 * @param filePath Relative path to the file within the repo
 * @param isUntracked Whether the file is untracked (needs rm instead of checkout)
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
    await execGitWithArgs(args, repoFullPath);
  } else {
    // For tracked files, use git checkout
    const args = ["checkout", "-q", "--", filePath];
    log(`Discarding changes: git ${args.join(" ")}`);
    await execGitWithArgs(args, repoFullPath);
  }
}

/**
 * Create git URIs using the same format as VS Code's git extension
 */
export function gitUri(uri: vscode.Uri, ref: string) {
  return uri.with({
    scheme: "git",
    query: JSON.stringify({ path: uri.fsPath, ref: ref }),
  });
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

  const output = await execGitWithArgs(args, repoFullPath);
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
    const output = await execGitWithArgs(args, repoFullPath);
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
  const output = await execGitWithArgs(args, repoFullPath);
  return output.trim();
}
