import { FileMetadata, DescriptionFormat } from "../types";

/**
 * Format a group description with file count and optional line changes
 */
export function formatGroupDescription(
  fileCount: number, linesAdded?: number, linesDeleted?: number): string {
  const parts = [`${fileCount} file${fileCount === 1 ? "" : "s"}`];
  
  const lineChanges = formatLineChanges(linesAdded, linesDeleted);
  if (lineChanges) {
    parts.push(lineChanges);
  }
  
  return parts.join(" • ");
}

/**
 * Format repository description with branch name, file count, and optional active pathspec / folder scope
 */
export function formatRepoDescription(
  branchName: string | undefined, fileCount: number, pathspec?: string, folderScope?: string): string {
  const filterParts: string[] = [];
  if (pathspec) {
    filterParts.push(`👣 ${pathspec}`);
  }
  if (folderScope) {
    filterParts.push(`📁 ${folderScope}`);
  }
  const filterSuffix = filterParts.length > 0 ? ` ${filterParts.join(" ")}` : "";
  if (fileCount === 0) {
    return branchName ? `🔀 ${branchName} (no fresh files)${filterSuffix}` : `(no fresh files)${filterSuffix}`;
  } else {
    return branchName ? `(${fileCount}) 🔀 ${branchName}${filterSuffix}` : `(${fileCount})${filterSuffix}`;
  }
}

/**
 * Format repository tooltip with name, branch, file count, and optional active pathspec / folder scope
 */
export function formatRepoTooltip(
  repoName: string, branchName: string | undefined, fileCount: number, pathspec?: string, folderScope?: string): string {
  const base = branchName
    ? `${repoName} (${branchName})\n${fileCount} file(s) modified`
    : `${repoName}\n${fileCount} file(s) modified`;
  let result = base;
  if (pathspec) {
    result += `\nPathspec filter: ${pathspec}`;
  }
  if (folderScope) {
    result += `\nScoped to folder: ${folderScope}`;
  }
  return result;
}

/**
 * Format directory tooltip with file count, most recent date, and line changes
 */
export function formatDirectoryTooltip(
  fileCount: number,
  mostRecent: Date,
  linesAdded?: number,
  linesDeleted?: number,
): string {
  let tooltip = `${fileCount} file(s) modified, most recent: ${formatRelativeDate(mostRecent)}`;
  
  const lineChanges = formatLineChanges(linesAdded, linesDeleted);
  if (lineChanges) {
    tooltip += ` (${lineChanges})`;
  }
  
  return tooltip;
}

/**
 * Formats a date as a concise relative time string
 * @param date The date to format
 * @returns A string like "now", "5m", "1h", "2d", "1w", "1mo", "1y"
 */
export function formatRelativeDate(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffDays / 365);

  if (diffSeconds < 60) {
    return "now";
  } else if (diffMinutes < 60) {
    return `${diffMinutes}m`;
  } else if (diffHours < 24) {
    return `${diffHours}h`;
  } else if (diffDays < 7) {
    return `${diffDays}d`;
  } else if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    return `${weeks}w`;
  } else if (diffMonths < 12) {
    return `${diffMonths}mo`;
  } else {
    return `${diffYears}y`;
  }
}

/**
 * Format a date as a human-readable relative string with full words, e.g. "3 days ago".
 * Suitable for tooltips where space is not a concern.
 */
export function formatRelativeDateLong(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffDays / 365);

  const p = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (diffSeconds < 60)  { return "just now"; }
  if (diffMinutes < 60)  { return p(diffMinutes, "minute"); }
  if (diffHours < 24)    { return p(diffHours, "hour"); }
  if (diffDays < 7)      { return p(diffDays, "day"); }
  if (diffDays < 30)     { return p(diffWeeks, "week"); }
  if (diffMonths < 12)   { return p(diffMonths, "month"); }
  return p(diffYears, "year");
}

/**
 * Map of git status codes to human-readable labels.
 */
const STATUS_LABELS: Record<string, string> = {
  // Standard statuses (from git log --name-status, single-char)
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type changed",
  "??": "untracked",
  "!!": "ignored",
  // Raw porcelain XY codes — unstaged only (X == ' ')
  " M": "modified",
  " D": "deleted",
  " A": "added",
  " T": "type changed",
  // Raw porcelain XY codes — staged only (Y == ' ')
  "M ": "modified (staged)",
  "A ": "added (staged)",
  "D ": "deleted (staged)",
  "R ": "renamed (staged)",
  "C ": "copied (staged)",
  "T ": "type changed (staged)",
  // Raw porcelain XY codes — staged + unstaged
  MM: "modified (staged + unstaged)",
  AM: "added (staged) + modified",
  AD: "added (staged) + deleted",
  MD: "modified (staged) + deleted",
  RM: "renamed (staged) + modified",
  // Merge conflict statuses
  UU: "conflict (both modified)",
  AA: "conflict (both added)",
  DD: "conflict (both deleted)",
  AU: "conflict (added by us)",
  UA: "conflict (added by them)",
  DU: "conflict (deleted by us)",
  UD: "conflict (deleted by them)",
};

/**
 * Get a human-readable status label for git status codes
 */
export function getStatusLabel(status: string): string {
  if (STATUS_LABELS[status]) {
    return STATUS_LABELS[status];
  }
  // Handle raw XY porcelain codes (e.g. " M", "M ", "A ", " D").
  // X is the staged position, Y is the working-tree position; one of them may be a space.
  // Use the non-space character as the canonical label key.
  if (status.length === 2 && status !== "??" && status !== "!!") {
    const key = status[1] !== " " ? status[1] : status[0];
    if (STATUS_LABELS[key]) {
      return STATUS_LABELS[key];
    }
  }
  // git log --name-status uses R<score> (e.g. R078, R100) for renames
  // and C<score> (e.g. C100) for copies. Normalise to the base letter.
  if (status.length > 1 && (status[0] === "R" || status[0] === "C") && /^\d+$/.test(status.slice(1))) {
    return STATUS_LABELS[status[0]] ?? status[0].toLowerCase();
  }
  return status.toLowerCase();
}

/**
 * Single-letter status badge (M/A/D/R/T/U…) for the description column. Mirrors
 * {@link getStatusLabel}'s porcelain-code canonicalization but returns the bare
 * letter, so the Fresh Files tree matches the Branch Compare badge vocabulary.
 * The word form stays in tooltips (hover detail).
 */
export function getStatusLetter(status: string): string {
  if (status === "??") { return "U"; } // untracked
  if (status === "!!") { return "!"; } // ignored
  // git log name-status renames/copies: R<score>/C<score>. Collapse copy → R to
  // match Branch Compare, which treats copies as renames for display.
  if (status.length >= 1 && (status[0] === "R" || status[0] === "C")) { return "R"; }
  // 2-char porcelain XY: prefer the working-tree (Y) position, else staged (X) —
  // same selection getStatusLabel uses.
  if (status.length === 2) {
    const key = status[1] !== " " ? status[1] : status[0];
    return key.toUpperCase();
  }
  return status.toUpperCase();
}

/** Emoji badge marking an AI co-authored change in tree descriptions. */
export const AI_COAUTHOR_BADGE = "🤖";

/**
 * Single source of truth for how AI co-authorship is presented.
 * `metadata` is any object carrying the two co-author fields (FileMetadata or
 * CommitData both qualify), so every tree surface renders it identically.
 */
export function formatAiCoAuthorTooltip(
  meta: { aiCoAuthored?: boolean; aiTools?: readonly string[] },
): string | undefined {
  if (!meta.aiCoAuthored) {
    return undefined;
  }
  const tools = meta.aiTools && meta.aiTools.length > 0 ? meta.aiTools.join(", ") : "AI agent";
  return `${AI_COAUTHOR_BADGE} Co-authored by: ${tools}`;
}

/**
 * Tooltip for a commit-group header, shared by the Fresh Files tree and the
 * Branch Compare tree so the two can't drift. Both render
 * `Commit / Author / Date / Files / [+X -Y] / [🤖 co-authored] / Message`;
 * the only structural difference is that Fresh Files knows per-commit line
 * totals (pass `lineChanges`) while Branch Compare does not (omit it).
 */
export function formatCommitTooltip(commit: {
  hash: string;
  author?: string;
  date: Date;
  fileCount: number;
  /** Pre-formatted "+X -Y" line, or undefined to omit the line entirely. */
  lineChanges?: string;
  aiCoAuthored?: boolean;
  aiTools?: readonly string[];
  message?: string;
}): string {
  const lines = [
    `Commit: ${commit.hash}`,
    `Author: ${commit.author || "(No author)"}`,
    `Date: ${formatRelativeDate(commit.date)}`,
    `Files: ${commit.fileCount}`,
  ];
  if (commit.lineChanges) {
    lines.push(commit.lineChanges);
  }
  const aiLine = formatAiCoAuthorTooltip(commit);
  if (aiLine) {
    lines.push(aiLine);
  }
  if (commit.message) {
    lines.push(`\nMessage:\n${commit.message}`);
  }
  return lines.join("\n");
}

/**
 * Truncate a string to a maximum length, adding ellipsis if needed
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.substring(0, maxLength - 1) + "…";
}

/**
 * Format line changes as a string (e.g., "+15 -3")
 * @param linesAdded The number of lines added (undefined or 0 for none)
 * @param linesDeleted The number of lines deleted (undefined or 0 for none)
 * @returns A formatted string like "+15 -3", or empty string if no changes
 */
export function formatLineChanges(linesAdded: number | undefined, linesDeleted: number | undefined): string {
  const added = linesAdded ?? 0;
  const deleted = linesDeleted ?? 0;

  if (added === 0 && deleted === 0) {
    return "";
  }

  const parts: string[] = [];
  if (added > 0) {
    parts.push(`+${added}`);
  }
  if (deleted > 0) {
    parts.push(`-${deleted}`);
  }

  return parts.length > 0 ? parts.join(" ") : "";
}

/**
 * Format line changes for tooltip display
 * @param linesAdded The number of lines added
 * @param linesDeleted The number of lines deleted
 * @returns A formatted string like "Lines: +15 -3", or undefined if no changes or feature disabled
 */
export function formatTooltipLineChanges(linesAdded?: number, linesDeleted?: number): string | undefined {
  if (!linesAdded && !linesDeleted) {
    return undefined;
  }

  const changeParts: string[] = [];
  if (linesAdded && linesAdded > 0) {
    changeParts.push(`+${linesAdded}`);
  }
  if (linesDeleted && linesDeleted > 0) {
    changeParts.push(`-${linesDeleted}`);
  }

  return `Lines: ${changeParts.join(" ")}`;
}

/**
 * Format file metadata into a description string based on configuration
 * @param metadata The file metadata
 * @param format The description format configuration
 * @returns A formatted description string
 */
export function formatFileDescription(metadata: FileMetadata, format: DescriptionFormat): string {
  const parts: string[] = [];

  // Pending entries are skipped:
  // VS Code's native git decoration already badges them
  if (format.showStatus && metadata.status && !metadata.isPending) {
    parts.push(getStatusLetter(metadata.status));
  }

  // Show line changes (+X -Y)
  if (format.showLineChanges) {
    const lineChanges = formatLineChanges(metadata.linesAdded, metadata.linesDeleted);
    if (lineChanges) {
      parts.push(lineChanges);
    }
  }

  // Show date
  if (format.showDate) {
    parts.push(formatRelativeDate(metadata.date));
  }

  // Show author (for historical changes)
  if (format.showAuthor && metadata.author) {
    parts.push(metadata.author);
  }

  // Show commit hash
  if (format.showCommitHash && metadata.commitHash) {
    parts.push(metadata.commitHash);
  }

  // Badge AI co-authored changes. Always shown (independent of format toggles)
  // and placed BEFORE the message so it survives the tree's single-line
  // ellipsis — a long message would otherwise push the badge off the right edge.
  if (metadata.aiCoAuthored) {
    parts.push(AI_COAUTHOR_BADGE);
  }

  // Show full commit message — it's the last part, so VS Code ellipsizes it at
  // the view edge. No manual truncation: the row can't wrap, so trimming only
  // discards text the user could otherwise read by widening the view.
  if (format.showCommitMessage && metadata.commitMessage) {
    parts.push(metadata.commitMessage);
  }

  return parts.join(" • ");
}

/**
 * Format file metadata into a detailed tooltip string
 * @param metadata The file metadata
 * @returns A formatted tooltip string
 */
export function formatFileTooltip(metadata: FileMetadata, format: DescriptionFormat): string {
  const lines: string[] = [];

  if (metadata.isDeleted) {
    // Tombstone format for deleted files
    lines.push("        R.I.P");
    lines.push(`† ${metadata.date.toLocaleDateString()} †`);
    lines.push("");
    lines.push("Cause of death:");
    if (metadata.author) {
      lines.push(`${metadata.author}`);
    }
    if (metadata.commitMessage) {
      lines.push(metadata.commitMessage);
    }
    if (metadata.commitHash) {
      lines.push(metadata.commitHash);
    }
    lines.push("");
    lines.push("Click to exhume");
    return lines.join("\n");
  }

  if (metadata.status) {
    let statusLine = `Status: ${getStatusLabel(metadata.status)}`;

    if (format.showLineChanges) {
      const lineChanges = formatLineChanges(metadata.linesAdded, metadata.linesDeleted);
      if (lineChanges) {
        statusLine += ` (${lineChanges})`;
      }
    }

    lines.push(statusLine);
  }

  lines.push(`Modified: ${formatRelativeDate(metadata.date)} (${metadata.date.toLocaleDateString()})`);

  if (metadata.author) {
    lines.push(`Author: ${metadata.author}`);
  }

  if (metadata.commitHash) {
    lines.push(`Commit: ${metadata.commitHash}`);
  }

  if (metadata.commitMessage) {
    lines.push(`Message: ${metadata.commitMessage}`);
  }

  const aiLine = formatAiCoAuthorTooltip(metadata);
  if (aiLine) {
    lines.push(aiLine);
  }

  return lines.join("\n");
}

/**
 * Escape a string for use as a regex pattern.
 */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Format a git argument list as a human-readable command string.
 * Args containing spaces or special characters are single-quoted.
 */
export function formatGitCommand(args: string[]): string {
  const formatted = args.map(arg =>
    /[ \t\n:*?"<>|\\]/.test(arg) ? `'${arg}'` : arg
  );
  return "git " + formatted.join(" ");
}

/**
 * Build a human-readable label for a number of days
 */
export function formatDaysLabel(days: number): string {
  const dayLabels: Record<number, string> = {
    [-1]: "Pending changes",
    1: "1 day",
    7: "1 week",
    14: "2 weeks",
    30: "1 month",
    60: "2 months",
    90: "3 months",
    180: "6 months",
    365: "1 year",
  };

  if (dayLabels.hasOwnProperty(days)) {
    return dayLabels[days];
  }

  return `${days} days`;
}

/**
 * Build a human-readable label for a time window magnitude expressed in
 * (possibly fractional) days. Sub-day windows are labelled in hours; everything
 * else defers to {@link formatDaysLabel}.
 */
export function formatTimeWindowLabel(days: number): string {
  if (days < 1) {
    const hours = Math.round(days * 24);
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return formatDaysLabel(days);
}

export function dotsDots(str: string, length = 80): string {
  return str.length > length ? str.substring(0, length - 3) + "..." : str;
}

export function shortSha(commitHash: string) {
  return commitHash.substring(0, 7);
}