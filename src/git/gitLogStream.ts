import * as cp from "child_process";
import * as path from "path";

import { log } from "../extension/logger";
import { CommitData, CommitStats, FileMetadata, asCommitAuthor, asCommitHash, asCommitMessage } from "../types";
import { ConfigService } from "../config/configService";
import { parseCommitDate } from "./gitDateUtils";
import { detectAiCoAuthors } from "../fresh-files/aiCoAuthor";
import { decodeGitPath, fileExists } from "./gitOperations";

/** Accumulate per-commit file-change stats from `onFileEntry` calls. */
function accumulateCommitStats(
  commitStatsMap: Map<string, CommitStats>,
  status: string,
  commit: CommitData,
): void {
  let entry = commitStatsMap.get(commit.hash);
  if (!entry) {
    entry = { commit, added: 0, deleted: 0, modified: 0 };
    commitStatsMap.set(commit.hash, entry);
  }
  if (status === "A") { entry.added++; }
  else if (status === "D") { entry.deleted++; }
  else { entry.modified++; }
}

/**
 * `git log` pretty-format token consumed by {@link createNameStatusLineProcessor}.
 * SINGLE SOURCE OF TRUTH — every caller of `streamGitLogNameStatus*` must pass
 * this exact format, or the parser's positional field assumptions (and the
 * `parts.length >= 5` guard) reject every commit line. The Co-authored-by
 * trailers field sits BEFORE `%s` so the subject stays last and can absorb any
 * literal `|` it contains via `parts.slice(4)`.
 */
export const COMMIT_NAME_STATUS_PRETTY =
  "--pretty=format:__COMMIT__%h|%aN|%aI|%(trailers:key=Co-authored-by,valueonly,separator=%x1f)|%s";

/**
 * Stateful line processor for `git log --name-status` output.
 * Calls `onFileEntry` for every file entry parsed, passing the workspace-relative
 * path, the git status code, and the enclosing commit.
 */
export function createNameStatusLineProcessor(
  repoRelativePath: string,
  onFileEntry: (relativePath: string, status: string, commit: CommitData) => void,
  aiCoAuthorEmails: ReadonlySet<string> = new Set(),
): (line: string) => void {
  let currentCommit: CommitData | null = null;

  return function processLine(rawLine: string) {
    const line = rawLine.trim();
    if (line.startsWith("__COMMIT__")) {
      // Pretty format: __COMMIT__%h|%aN|%aI|<co-author trailers>|%s
      // The trailers field sits BEFORE the subject (parts[3]) so the subject can
      // stay last and absorb any literal `|` it contains via slice(4).join("|").
      // The trailers field itself joins multiple co-authors with AI_TRAILER_SEPARATOR
      // (0x1f), so it never contains `|` unless a co-author *name* does — vanishingly rare.
      const parts = line.substring("__COMMIT__".length).split("|");
      if (parts.length >= 5) {
        const { date, tzOffsetMinutes } = parseCommitDate(parts[2]);
        const { aiCoAuthored, tools } = detectAiCoAuthors(parts[3], aiCoAuthorEmails);
        currentCommit = {
          hash: asCommitHash(parts[0]),
          author: asCommitAuthor(parts[1]),
          date,
          tzOffsetMinutes,
          message: asCommitMessage(parts.slice(4).join("|")),
          aiCoAuthored,
          aiTools: tools.length > 0 ? tools : undefined,
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
  commitStatsMap?: Map<string, CommitStats>,
  aiCoAuthorEmails?: ReadonlySet<string>,
): Promise<Map<string, { status: string; commit: CommitData }>> {
  const fileStatusMap = new Map<string, { status: string; commit: CommitData }>();
  const processLine = createNameStatusLineProcessor(repoRelativePath, (relativePath, status, commit) => {
    if (!fileStatusMap.has(relativePath)) {
      fileStatusMap.set(relativePath, { status, commit });
    }
    if (commitStatsMap) {
      accumulateCommitStats(commitStatsMap, status, commit);
    }
  }, aiCoAuthorEmails);
  return spawnGitLines(args, cwd, timeout, processLine).then(() => fileStatusMap);
}

/**
 * Like `streamGitLogNameStatus` but fires `onThresholdCrossed` each time the stream
 * crosses into commits older than a configured day threshold.
 *
 * Since git log streams newest-first, when we encounter the first commit whose date
 * is older than `now - days`, every file touched within that window is already in the
 * map — we therefore snapshot the map and fire the callback for that threshold.
 *
 * @param thresholds  Day values, sorted **ascending** (e.g. [7, 14, 30]).
 * @param now         Reference timestamp (should be Date.now() at call time).
 * @param onThresholdCrossed  Called synchronously with the snapshot at each crossing.
 */
export function streamGitLogNameStatusWithProgress(
  args: string[],
  cwd: string,
  repoRelativePath: string,
  timeout: number | undefined,
  thresholds: number[],
  now: Date,
  onThresholdCrossed: (days: number, snapshot: Map<string, { status: string; commit: CommitData }>) => void,
  commitStatsMap?: Map<string, CommitStats>,
  aiCoAuthorEmails?: ReadonlySet<string>,
): Promise<Map<string, { status: string; commit: CommitData }>> {
  const fileStatusMap = new Map<string, { status: string; commit: CommitData }>();
  // Work through thresholds ascending so smaller windows fire first.
  const remaining = [...thresholds].sort((a, b) => a - b);

  const baseProcessLine = createNameStatusLineProcessor(repoRelativePath, (relativePath, status, commit) => {
    if (!fileStatusMap.has(relativePath)) {
      fileStatusMap.set(relativePath, { status, commit });
    }
    if (commitStatsMap) {
      accumulateCommitStats(commitStatsMap, status, commit);
    }
  }, aiCoAuthorEmails);

  const processLine = (rawLine: string) => {
    const line = rawLine.trim();
    // Intercept commit headers to detect threshold crossings BEFORE the file entries
    // for this (older) commit are added to the map.
    if (line.startsWith("__COMMIT__") && remaining.length > 0) {
      const parts = line.substring("__COMMIT__".length).split("|");
      if (parts.length >= 3) {
        const commitDate = new Date(parts[2]);
        // Thresholds are ascending; fire each one whose cutoff the commit date crosses.
        while (remaining.length > 0) {
          const days = remaining[0];
          const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
          if (commitDate < cutoff) {
            remaining.shift();
            onThresholdCrossed(days, new Map(fileStatusMap));
          } else {
            break; // Remaining thresholds are larger; this commit is still within them.
          }
        }
      }
    }
    baseProcessLine(rawLine);
  };

  return spawnGitLines(args, cwd, timeout, processLine).then(() => {
    // Fire any thresholds that were never crossed (repo history shorter than the window).
    for (const days of remaining) {
      onThresholdCrossed(days, new Map(fileStatusMap));
    }
    return fileStatusMap;
  });
}

/**
 * Stateful line processor for `git diff --numstat` output (no commit headers).
 * Calls `onEntry` for each valid, non-binary line.
 */
export function createDiffNumstatLineProcessor(
  onEntry: (fileName: string, added: number, deleted: number) => void,
): (line: string) => void {
  return function processLine(rawLine: string) {
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
    onEntry(fileName, added, deleted);
  };
}

/** Streaming `git diff --numstat`. Repo-relative keys. */
export function streamGitDiffNumstat(
  args: string[],
  cwd: string,
  timeout: number | undefined,
): Promise<Map<string, { added: number; deleted: number }>> {
  const map = new Map<string, { added: number; deleted: number }>();
  const processLine = createDiffNumstatLineProcessor((fileName, added, deleted) => {
    if (!map.has(fileName)) {
      map.set(fileName, { added, deleted });
    }
  });
  return spawnGitLines(args, cwd, timeout, processLine).then(() => map);
}

/**
 * Build a FileMetadata map from a raw name-status snapshot, running fileExists checks.
 * Line counts are omitted (not available until the numstat pass).
 */
async function buildPartialMetadataMap(
  snapshot: Map<string, { status: string; commit: CommitData }>,
  workspaceRoot: string,
): Promise<Map<string, FileMetadata>> {
  const entries = Array.from(snapshot.entries());
  const existsResults = await Promise.all(
    entries.map(([fileRelativePath]) => fileExists(path.join(workspaceRoot, fileRelativePath))),
  );
  const result = new Map<string, FileMetadata>();
  for (let i = 0; i < entries.length; i++) {
    const [fileRelativePath, statusInfo] = entries[i];
    const existsOnDisk = existsResults[i];
    const isDeleted = statusInfo.status === "D";
    if (existsOnDisk || isDeleted) {
      result.set(fileRelativePath, {
        date: statusInfo.commit.date,
        author: statusInfo.commit.author,
        commitHash: statusInfo.commit.hash,
        commitMessage: statusInfo.commit.message,
        status: statusInfo.status,
        isDeleted: !existsOnDisk,
        isPending: false,
        aiCoAuthored: statusInfo.commit.aiCoAuthored,
        aiTools: statusInfo.commit.aiTools,
      });
    }
  }
  return result;
}

/**
 * Collect historical changes from git log within a time window.
 *
 * @param repoRelativePath  Path relative to workspace root (empty string for root)
 * @param repoFullPath      Full filesystem path to the repository
 * @param workspaceRoot     The workspace root path
 * @param days              Number of days to look back (the maximum window to load)
 * @param pathspec          Optional git pathspec to restrict which files are included
 * @param thresholds        Optional sorted-ascending day values at which incremental
 *                          snapshots should be emitted via `onThresholdCrossed`.
 * @param onThresholdCrossed Called (fire-and-forget async) with a partial FileMetadata
 *                           map each time the stream crosses a threshold boundary.
 * @returns Map of file paths (relative to workspace) to file metadata including commit info
 */
export async function collectHistoricalChanges(
  repoRelativePath: string,
  repoFullPath: string,
  workspaceRoot: string,
  days: number,
  pathspec?: string,
  thresholds?: number[],
  onThresholdCrossed?: (days: number, partial: Map<string, FileMetadata>) => void,
  commitStatsMap?: Map<string, CommitStats>,
): Promise<Map<string, FileMetadata>> {
  // Compute an exact cutoff timestamp instead of git's approxidate ("N.days.ago").
  // Approxidate silently mishandles fractional days (e.g. "0.25.days.ago" drops the
  // "0."), which breaks sub-day windows. An absolute ISO instant is exact and stays
  // coherent with the threshold-crossing math below, which uses the same `now` and
  // the same `days * 86400000` arithmetic.
  const now = new Date();
  const sinceDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

  // Build a shared pathspec suffix: ["--", "<pathspec>"] when a pathspec is active.
  // The "--" separator is required to distinguish pathspecs from revision arguments.
  const pathspecSuffix: string[] = pathspec ? ["--", pathspec] : [];

  // Step 1: Get file statuses using --name-status (streamed to avoid buffering 10+ MB)
  // --author-date-order: sort commits by author date (newest first).
  // This is required for coherence: --since filters by author date, %aI returns author date,
  // and our threshold-crossing logic assumes commit dates
  // arrive in monotonically-decreasing order. Default git log order is by committer date, which
  // can diverge from author date on rebased or cherry-picked commits and break threshold detection.
  const statusArgs = ["log", `--since=${sinceDate}`, "--author-date-order", "--name-status", COMMIT_NAME_STATUS_PRETTY, ...pathspecSuffix];
  log(`Executing git command for status in ${repoRelativePath || "root"}: git ${statusArgs.join(" ")}`);

  const aiCoAuthorEmails = ConfigService.getAiCoAuthorEmails();

  let fileStatusMap: Map<string, { status: string; commit: CommitData }>;
  if (thresholds && thresholds.length > 0 && onThresholdCrossed) {
    fileStatusMap = await streamGitLogNameStatusWithProgress(
      statusArgs, repoFullPath, repoRelativePath, ConfigService.getGitTimeoutMs(),
      thresholds, now,
      (thresholdDays, snapshot) => {
        // Fire-and-forget: build FileMetadata for the snapshot and call the outer callback.
        buildPartialMetadataMap(snapshot, workspaceRoot).then(partial => {
          onThresholdCrossed(thresholdDays, partial);
        }).catch(() => { /* ignore — best-effort incremental update */ });
      },
      commitStatsMap,
      aiCoAuthorEmails,
    );
  } else {
    fileStatusMap = await streamGitLogNameStatus(statusArgs, repoFullPath, repoRelativePath, ConfigService.getGitTimeoutMs(), commitStatsMap, aiCoAuthorEmails);
  }

  // Step 2: Merge status into FileMetadata (exists-check + historical-delete handling).
  return buildPartialMetadataMap(fileStatusMap, workspaceRoot);
}
