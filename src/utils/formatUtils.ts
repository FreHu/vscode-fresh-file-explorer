import { FileMetadata, DescriptionFormat } from "../types";
import { ConfigService } from "../config/configService";

/**
 * Calculate total line changes from items with metadata.
 * Returns undefined if the feature is disabled to avoid unnecessary work.
 */
export function calculateTotalLineChanges<T extends { metadata: FileMetadata }>(
  items: T[],
): { added: number; deleted: number } | undefined {
  // Check if feature is enabled first to avoid unnecessary work
  if (!ConfigService.getDescriptionFormat().showLineChanges) {
    return undefined;
  }

  return items.reduce(
    (totals, item) => ({
      added: totals.added + (item.metadata.linesAdded ?? 0),
      deleted: totals.deleted + (item.metadata.linesDeleted ?? 0),
    }),
    { added: 0, deleted: 0 },
  );
}

/**
 * Format a group description with file count and optional line changes
 */
export function formatGroupDescription(fileCount: number, linesAdded?: number, linesDeleted?: number): string {
  const parts = [`${fileCount} file${fileCount === 1 ? "" : "s"}`];
  
  const lineChanges = formatLineChanges(linesAdded, linesDeleted);
  if (lineChanges) {
    parts.push(lineChanges);
  }
  
  return parts.join(" • ");
}

/**
 * Format repository description with branch name and file count
 */
export function formatRepoDescription(branchName: string | undefined, fileCount: number): string {
  if (fileCount === 0) {
    return branchName ? `🔀 ${branchName} (no fresh files)` : "(no fresh files)";
  } else {
    return branchName ? `(${fileCount}) 🔀 ${branchName} ` : `(${fileCount})`;
  }
}

/**
 * Format repository tooltip with name, branch, and file count
 */
export function formatRepoTooltip(repoName: string, branchName: string | undefined, fileCount: number): string {
  return branchName
    ? `${repoName} (${branchName})\n${fileCount} file(s) modified`
    : `${repoName}\n${fileCount} file(s) modified`;
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
 * Get a human-readable status label for git status codes
 */
function getStatusLabel(status: string): string {
  switch (status) {
    // Standard statuses
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type changed";
    case "??":
      return "untracked";
    case "!!":
      return "ignored";
    // Staged + unstaged combinations
    case "MM":
      return "modified";
    case "AM":
      return "added";
    case "AD":
      return "deleted";
    case "MD":
      return "deleted";
    case "RM":
      return "renamed";
    // Merge conflict statuses
    case "UU":
      return "conflict (both modified)";
    case "AA":
      return "conflict (both added)";
    case "DD":
      return "conflict (both deleted)";
    case "AU":
      return "conflict (added by us)";
    case "UA":
      return "conflict (added by them)";
    case "DU":
      return "conflict (deleted by us)";
    case "UD":
      return "conflict (deleted by them)";
    default:
      return status.toLowerCase();
  }
}

/**
 * Truncate a string to a maximum length, adding ellipsis if needed
 */
function truncate(str: string, maxLength: number): string {
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
function formatLineChanges(linesAdded: number | undefined, linesDeleted: number | undefined): string {
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

  // For pending changes, show status
  if (format.showStatus && metadata.status) {
    parts.push(getStatusLabel(metadata.status));
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

  // Show commit message (truncated)
  if (format.showCommitMessage && metadata.commitMessage) {
    parts.push(truncate(metadata.commitMessage, 30));
  }

  return parts.join(" • ");
}

/**
 * Format file metadata into a detailed tooltip string
 * @param metadata The file metadata
 * @returns A formatted tooltip string
 */
export function formatFileTooltip(metadata: FileMetadata): string {
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
    
    // Add line changes if available
    const lineChanges = formatLineChanges(metadata.linesAdded, metadata.linesDeleted);
    if (lineChanges) {
      statusLine += ` (${lineChanges})`;
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

  return lines.join("\n");
}
