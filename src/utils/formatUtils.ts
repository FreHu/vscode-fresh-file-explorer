import { FileMetadata, DescriptionFormat } from "../types";

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
 * Format directory tooltip with file count and most recent date
 */
export function formatDirectoryTooltip(fileCount: number, mostRecent: Date): string {
  return `${fileCount} file(s) modified, most recent: ${formatRelativeDate(mostRecent)}`;
}

/**
 * Formats a date as a human-readable relative time string
 * @param date The date to format
 * @returns A string like "just now", "5 minutes ago", "yesterday", etc.
 */
export function formatRelativeDate(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffMinutes = Math.floor(diffMs / (1000 * 60));

  if (diffMinutes < 60) {
    return diffMinutes <= 1 ? "just now" : `${diffMinutes} minutes ago`;
  } else if (diffHours < 24) {
    return diffHours === 1 ? "1 hour ago" : `${diffHours} hours ago`;
  } else if (diffDays < 7) {
    return diffDays === 1 ? "yesterday" : `${diffDays} days ago`;
  } else if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
  } else {
    const months = Math.floor(diffDays / 30);
    return months === 1 ? "1 month ago" : `${months} months ago`;
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
    lines.push(`Status: ${getStatusLabel(metadata.status)}`);
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
