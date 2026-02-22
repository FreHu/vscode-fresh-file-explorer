/**
 * Minimal parser for `git log -L` output.
 *
 * Each "entry" in -L output looks like:
 *
 *   commit <hash>
 *   Author: Name <email>
 *   Date:   <date>
 *
 *       <message>
 *
 *   diff --git a/<file> b/<file>
 *   --- a/<file>
 *   +++ b/<file>
 *   @@ -s,l +s,l @@
 *    context
 *   -removed
 *   +added
 *
 * We capture the metadata and the raw hunk text for each commit.
 */

export interface GitLogLCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: Date;
  message: string;
  /** Raw diff hunk lines (including @@ header), empty for merge commits */
  hunk: string;
  /** Lines added in this commit's hunk */
  added: number;
  /** Lines removed in this commit's hunk */
  removed: number;
  /** Path of the file at this commit (may differ from current path due to renames) */
  filePathAtCommit: string | null;
}

export function parseGitLogL(raw: string): GitLogLCommit[] {
  const commits: GitLogLCommit[] = [];
  // Split on "commit <40-char-hash>" boundaries, keep the delimiter
  const blocks = raw.split(/(?=^commit [0-9a-f]{40})/m).filter(b => b.trim().length > 0);

  for (const block of blocks) {
    const lines = block.split("\n");
    const hashMatch = lines[0].match(/^commit ([0-9a-f]{40})/);
    if (!hashMatch) { continue; }
    const hash = hashMatch[1];
    const shortHash = hash.slice(0, 8);

    let author = "";
    let dateStr = "";
    let messageLines: string[] = [];
    let hunkLines: string[] = [];
    let filePathAtCommit: string | null = null;

    let i = 1;

    // Parse headers (Author:, Date:, Merge:, etc.)
    while (i < lines.length && !lines[i].startsWith("    ") && lines[i].trim() !== "") {
      const authorMatch = lines[i].match(/^Author:\s*(.+)/);
      if (authorMatch) { author = authorMatch[1].trim(); }
      const dateMatch = lines[i].match(/^Date:\s*(.+)/);
      if (dateMatch) { dateStr = dateMatch[1].trim(); }
      i++;
    }

    // Skip blank line before message
    while (i < lines.length && lines[i].trim() === "") { i++; }

    // Collect message (indented lines before the diff)
    while (i < lines.length && (lines[i].startsWith("    ") || lines[i].trim() === "")) {
      if (lines[i].startsWith("    ")) {
        messageLines.push(lines[i].slice(4));
      }
      i++;
      // Stop at diff header
      if (i < lines.length && lines[i].startsWith("diff ")) { break; }
    }

    // Skip diff --git / --- / +++ header lines, collect from @@ onward
    // But capture the file path from `+++ b/<path>` (the path at this commit)
    while (i < lines.length && !lines[i].startsWith("@@")) {
      const pppMatch = lines[i].match(/^\+\+\+ b\/(.+)/);
      if (pppMatch) { filePathAtCommit = pppMatch[1].trim(); }
      i++;
    }
    while (i < lines.length) {
      hunkLines.push(lines[i]);
      i++;
    }

    const hunk = hunkLines.join("\n").trimEnd();
    let added = 0, removed = 0;
    for (const line of hunkLines) {
      if (line.startsWith("+") && !line.startsWith("++")) { added++; }
      else if (line.startsWith("-") && !line.startsWith("--")) { removed++; }
    }
    commits.push({
      hash,
      shortHash,
      author,
      date: dateStr ? new Date(dateStr) : new Date(0),
      message: messageLines.join("\n").trim(),
      hunk,
      added,
      removed,
      filePathAtCommit,
    });
  }

  return commits;
}
