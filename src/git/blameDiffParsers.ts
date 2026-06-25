/**
 * Pure parsers for git porcelain blame + unified-diff output, consumed by the
 * blame heatmap. Extracted from gitOperations.ts so the coordinator stays a
 * thin command-runner and this string-crunching logic lives behind a unit-test
 * boundary of its own. No vscode / process imports — keep it pure.
 */

export interface BlameLineInfo {
  /** 0-indexed line number in the final file. */
  lineIndex: number;
  /** Full 40-char SHA1 of the commit that last touched this line. */
  sha: string;
  /** Unix timestamp in seconds from the author-time field. */
  timestamp: number;
  /** Author name from the author field. */
  author: string;
  /** Commit summary (first line of commit message). */
  summary: string;
}

/**
 * Parse `git blame --porcelain` output into per-line data.
 *
 * Pure function — takes the raw output string and returns one entry per
 * blamed line containing the 0-based line index, the author-time unix
 * timestamp (in seconds), the author name, and the commit summary.
 */
export function parseGitBlamePorcelain(output: string): BlameLineInfo[] {
  const lines = output.split("\n");

  interface CommitInfo {
    timestamp: number;
    author: string;
    summary: string;
  }
  /** Commit sha1 → cached info. Populated on first occurrence. */
  const commitCache = new Map<string, CommitInfo>();

  const result: BlameLineInfo[] = [];

  let currentSha = "";
  let currentFinalLine = 0;
  /** True while we are inside the header block of a commit seen for the first time. */
  let inNewCommit = false;
  let pendingAuthor = "";
  let pendingTimestamp = 0;
  let pendingSummary = "";

  for (const line of lines) {
    if (!line) continue;

    // Commit header line:  <sha1> <orig_line> <final_line> [<num_lines>]
    // The sha1 is always 40 hex chars.
    if (/^[0-9a-f]{40} /.test(line)) {
      const parts = line.split(" ");
      currentSha = parts[0];
      currentFinalLine = parseInt(parts[2], 10);
      inNewCommit = !commitCache.has(currentSha);
      if (inNewCommit) {
        pendingAuthor = "";
        pendingTimestamp = 0;
        pendingSummary = "";
      }
      continue;
    }

    if (inNewCommit) {
      // "author <name>" — note: "author-mail", "author-time" etc. start with "author-"
      if (line.startsWith("author ")) {
        pendingAuthor = line.substring("author ".length);
        continue;
      }
      if (line.startsWith("author-time ")) {
        const ts = parseInt(line.substring("author-time ".length), 10);
        if (!isNaN(ts)) {
          pendingTimestamp = ts;
        }
        continue;
      }
      if (line.startsWith("summary ")) {
        pendingSummary = line.substring("summary ".length);
        continue;
      }
    }

    // Actual source line content is prefixed with a tab.
    if (line.startsWith("\t")) {
      if (inNewCommit) {
        commitCache.set(currentSha, {
          timestamp: pendingTimestamp,
          author: pendingAuthor,
          summary: pendingSummary,
        });
        inNewCommit = false;
      }
      const info = commitCache.get(currentSha);
      if (info) {
        result.push({
          lineIndex: currentFinalLine - 1,
          sha: currentSha,
          timestamp: info.timestamp,
          author: info.author,
          summary: info.summary,
        });
      }
      continue;
    }
  }

  return result;
}

export interface DeletedHunk {
  /**
   * 1-based line number in the **new** file after which the deletion gap begins.
   * A value of 0 means the deletion is at the very beginning of the file (before
   * line 1 in the new file).
   */
  afterNewLine1: number;
  /** Number of lines that were deleted from the old file. */
  count: number;
  /** The actual content of the deleted lines (without the leading "-" prefix). */
  lines: string[];
}

export interface BranchDiffHunks {
  /** Pure-deletion hunks (lines removed, none added in their place). */
  deletions: DeletedHunk[];
  /** 1-based new-file line numbers for lines added with no deletion at that spot (pure additions). */
  addedLines: Set<number>;
  /** 1-based new-file line numbers for lines that replaced deleted lines (mixed hunks). */
  modifiedLines: Set<number>;
}

/**
 * Parse `git diff --unified=0` (or similar) output into the three categories
 * the blame heatmap cares about:
 *
 * - `deletions`     — pure-deletion hunks; surface as gutter badges.
 * - `addedLines`    — line numbers from pure-addition hunks (OLDCOUNT==0).
 * - `modifiedLines` — line numbers from mixed hunks' `+` portion (OLDCOUNT>0 AND NEWCOUNT>0).
 *
 * Splitting added vs modified lets the controller tint them differently —
 * brand-new code reads as different signal than a touched line.
 *
 * Pure function. Takes the raw diff string, returns one populated record.
 */
export function parseBranchHunks(diffOutput: string): BranchDiffHunks {
  const deletions: DeletedHunk[] = [];
  const addedLines = new Set<number>();
  const modifiedLines = new Set<number>();
  let currentDeletion: DeletedHunk | null = null;

  for (const line of diffOutput.split("\n")) {
    if (line.startsWith("@@")) {
      // e.g.  @@ -10,3 +9,0 @@  or  @@ -5 +4,0 @@  (omitted ,1 means count=1)
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      currentDeletion = null;
      if (!m) continue;
      const oldCount = m[2] !== undefined ? parseInt(m[2], 10) : 1;
      const newCount = m[4] !== undefined ? parseInt(m[4], 10) : 1;
      const newStart = parseInt(m[3], 10); // NEWSTART; 0 means before first line for pure deletions

      if (oldCount > 0 && newCount === 0) {
        // Pure deletion
        currentDeletion = { afterNewLine1: newStart, count: oldCount, lines: [] };
        deletions.push(currentDeletion);
      } else if (oldCount === 0 && newCount > 0) {
        // Pure addition — record the new-file line range.
        for (let i = 0; i < newCount; i++) { addedLines.add(newStart + i); }
      } else if (oldCount > 0 && newCount > 0) {
        // Mixed (replacement) — the `+` lines occupy [newStart, newStart+newCount-1].
        for (let i = 0; i < newCount; i++) { modifiedLines.add(newStart + i); }
      }
      continue;
    }
    if (currentDeletion && line.startsWith("-")) {
      currentDeletion.lines.push(line.slice(1)); // strip leading "-"
    }
  }
  return { deletions, addedLines, modifiedLines };
}
