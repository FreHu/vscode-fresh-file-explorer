import { CommitHash, FileMetadata } from "../types";
import { log } from "../extension/logger";

/**
 * Tri-state filter for AI co-authored changes (commits with a known AI-agent
 * `Co-authored-by` trailer). Orthogonal to the author/commit filters.
 *  - "all":  no filtering (default)
 *  - "only": show ONLY AI co-authored changes
 *  - "hide": hide AI co-authored changes
 */
export type AiFilterMode = "all" | "only" | "hide";

/**
 * Manages filter state for the Fresh File Explorer.
 * Handles author, commit, and AI co-authorship filtering.
 */
export class FilterManager {
  private excludedAuthors: Set<string> = new Set();
  private excludedCommits: Set<CommitHash> = new Set();
  private aiFilter: AiFilterMode = "all";
  private onChangeCallback?: () => void;

  /**
   * Initialize with a callback that's invoked when filters change
   */
  initialize(onChangeCallback?: () => void): void {
    this.onChangeCallback = onChangeCallback;
  }

  /**
   * Set excluded authors (files by these authors will be hidden)
   */
  setExcludedAuthors(authors: Set<string>): void {
    this.excludedAuthors = authors;
    log(`Filter: excluding ${authors.size} author(s): ${Array.from(authors).join(", ")}`);
    this.onChangeCallback?.();
  }

  /**
   * Set excluded commits (files from these commits will be hidden)
   */
  setExcludedCommits(commits: Set<CommitHash>): void {
    this.excludedCommits = commits;
    log(`Filter: excluding ${commits.size} commit(s): ${Array.from(commits).join(", ")}`);
    this.onChangeCallback?.();
  }

  /**
   * Set the AI co-authorship filter mode.
   */
  setAiFilter(mode: AiFilterMode): void {
    this.aiFilter = mode;
    log(`Filter: AI co-authored changes → ${mode}`);
    this.onChangeCallback?.();
  }

  /**
   * Get the current AI co-authorship filter mode.
   */
  getAiFilter(): AiFilterMode {
    return this.aiFilter;
  }

  /**
   * Clear all filters
   */
  clearFilters(): void {
    this.excludedAuthors.clear();
    this.excludedCommits.clear();
    this.aiFilter = "all";
    this.onChangeCallback?.();
  }

  /**
   * Check if any filters are active
   */
  hasActiveFilters(): boolean {
    return this.excludedAuthors.size > 0 || this.excludedCommits.size > 0 || this.aiFilter !== "all";
  }

  /**
   * Get current filter summary for display
   */
  getFilterSummary(): string {
    const parts: string[] = [];
    if (this.excludedAuthors.size > 0) {
      parts.push(`${this.excludedAuthors.size} author(s) hidden`);
    }
    if (this.excludedCommits.size > 0) {
      parts.push(`${this.excludedCommits.size} commit(s) hidden`);
    }
    if (this.aiFilter === "only") {
      parts.push("only AI co-authored");
    } else if (this.aiFilter === "hide") {
      parts.push("AI co-authored hidden");
    }
    return parts.join(", ");
  }

  /**
   * Check if a file passes the current filters
   */
  passesFilters(metadata: FileMetadata): boolean {
    if (this.aiFilter !== "all") {
      // Pending (uncommitted) changes have no commit, so no co-author trailer —
      // treat them as not AI co-authored.
      const isAi = metadata.aiCoAuthored === true;
      if (this.aiFilter === "only" && !isAi) {
        return false;
      }
      if (this.aiFilter === "hide" && isAi) {
        return false;
      }
    }

    if (this.excludedAuthors.size === 0 && this.excludedCommits.size === 0) {
      return true;
    }
    const author = metadata.author || "(unknown)";
    const commitHash = metadata.commitHash;

    if (this.excludedAuthors.has(author)) {
      return false;
    }
    if (commitHash && this.excludedCommits.has(commitHash)) {
      return false;
    }
    return true;
  }

  /**
   * Get excluded authors set (for external access)
   */
  getExcludedAuthors(): Set<string> {
    return this.excludedAuthors;
  }

  /**
   * Get excluded commits set (for external access)
   */
  getExcludedCommits(): Set<CommitHash> {
    return this.excludedCommits;
  }
}
