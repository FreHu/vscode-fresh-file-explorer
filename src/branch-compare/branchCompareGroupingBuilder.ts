import * as vscode from "vscode";

import { ChangedFile } from "./branchCompareData";
import { SortOrder } from "../types";
import { GroupingMode } from "../fresh-files/groupingMode";
import { getMoonPhase } from "../fresh-files/moonPhase";
import { formatRelativeDate, formatCommitTooltip, AI_COAUTHOR_BADGE } from "../utils/formatUtils";
import { BranchCompareContextValues, PENDING_GROUP_KEY } from "./branchCompareConstants";

/**
 * Tree item for a group header in the Branch Compare view.
 */
export class BranchCompareGroupItem extends vscode.TreeItem {
  readonly kind = "group" as const;
  readonly isDirectory = true;
  constructor(
    /** Stable identifier of the group within its comparison (e.g. author name, commit hash). */
    public readonly groupKey: string,
    /** Repo this group belongs to. */
    public readonly repoFullPath: string,
    /** The comparison this group belongs to — used to look up the baseline target ref. */
    public readonly comparisonId: string,
    /** Group items so the tree provider can hand back the right list. */
    public readonly files: ChangedFile[],
    label: string,
    description: string,
    tooltip: string,
    icon: string,
    /** Precomputed by the builder — pending / commit / generic group (see {@link buildGroupedItems}). */
    contextValue: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    // Distinct id prefix per comparison so VS Code's tree-state cache doesn't
    // fold groups across different comparisons that happen to share a label.
    this.id = `branchCompare:group:${comparisonId}:${groupKey}`;
    this.description = description;
    this.tooltip = tooltip;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = contextValue;
  }
}

/**
 * Group key extractor for non-File-Structure modes. Returns the group label
 * a file should land under, plus an icon hint for the eventual header.
 */
function groupKeyFor(file: ChangedFile, mode: GroupingMode): { key: string; label: string; icon: string } {
  if (file.isPending || !file.commit) {
    // Any non-File-Structure mode buckets uncommitted / unattributed entries
    // together — none of the grouping keys (author/hash/date) are defined for
    // them.
    return { key: PENDING_GROUP_KEY, label: PENDING_GROUP_KEY, icon: "edit" };
  }

  switch (mode) {
    case "Author":
      return { key: file.commit.author, label: file.commit.author, icon: "person" };
    case "Commit Hash":
      return { key: file.commit.hash, label: file.commit.hash, icon: "git-commit" };
    case "Moon Phase": {
      const phase = getMoonPhase(file.commit.date);
      const label = `${phase.emoji} ${phase.name}`;
      return { key: phase.name, label, icon: "circle-filled" };
    }
    default:
      // Should not be called for File Structure / Flat List
      return { key: "", label: "", icon: "folder" };
  }
}

/**
 * Group changed files by the chosen mode and return ready-to-render group
 * items. Sorted so the most-recently-active group appears first (most
 * recent commit date in that group).
 *
 * Pure-ish — only side effect is constructing TreeItem instances, which the
 * provider hands back from `getChildren`.
 */
export function buildGroupedItems(
  comparisonId: string,
  repoFullPath: string,
  files: ChangedFile[],
  mode: GroupingMode,
): BranchCompareGroupItem[] {
  if (mode === "File Structure" || mode === "Flat List") {
    return [];
  }

  const groups = new Map<string, { files: ChangedFile[]; label: string; icon: string; mostRecent: Date }>();
  for (const file of files) {
    const { key, label, icon } = groupKeyFor(file, mode);
    const date = file.commit?.date ?? new Date(0);
    const existing = groups.get(key);
    if (existing) {
      existing.files.push(file);
      if (date > existing.mostRecent) { existing.mostRecent = date; }
    } else {
      groups.set(key, { files: [file], label, icon, mostRecent: date });
    }
  }

  // Pending pins to the top (matches Fresh Files); the rest sort most-recent first.
  const sorted = [...groups.entries()].sort((a, b) => {
    if (a[0] === PENDING_GROUP_KEY) { return -1; }
    if (b[0] === PENDING_GROUP_KEY) { return 1; }
    return b[1].mostRecent.getTime() - a[1].mostRecent.getTime();
  });

  const items: BranchCompareGroupItem[] = [];
  for (const [key, group] of sorted) {
    const fileCount = group.files.length;
    let description: string;
    let tooltip: string;

    if (mode === "Commit Hash") {
      // Commit hash groups carry rich metadata when the first file's commit
      // is known. Pending bucket falls back to a count-only description.
      const firstCommit = group.files.find(f => f.commit)?.commit;
      if (firstCommit) {
        const parts = [`${fileCount} file${fileCount === 1 ? "" : "s"}`, firstCommit.author];
        // Time on the header (matches Fresh Files); the file rows carry only name + status.
        parts.push(formatRelativeDate(firstCommit.date));
        // Badge before the message so it survives the tree's single-line ellipsis.
        if (firstCommit.aiCoAuthored) { parts.push(AI_COAUTHOR_BADGE); }
        // Full message, last — VS Code ellipsizes it at the view edge; no manual trim.
        if (firstCommit.message) { parts.push(firstCommit.message); }
        description = parts.join(" • ");
        tooltip = formatCommitTooltip({
          hash: firstCommit.hash,
          author: firstCommit.author,
          date: firstCommit.date,
          fileCount,
          aiCoAuthored: firstCommit.aiCoAuthored,
          aiTools: firstCommit.aiTools,
          message: firstCommit.message,
        });
      } else {
        description = `${fileCount} file${fileCount === 1 ? "" : "s"}`;
        tooltip = `Pending changes\n${fileCount} file(s)`;
      }
    } else {
      description = `(${fileCount})`;
      const dateLabel = group.mostRecent.getTime() > 0
        ? `\nMost recent: ${formatRelativeDate(group.mostRecent)}`
        : "";
      tooltip = `${group.label}\n${fileCount} file(s)${dateLabel}`;
    }

    // Pending bucket carries working-tree actions; a real commit-hash group
    // carries "open commit"
    const contextValue = key === PENDING_GROUP_KEY
      ? BranchCompareContextValues.GROUP_PENDING
      : mode === "Commit Hash"
        ? BranchCompareContextValues.GROUP_COMMIT
        : BranchCompareContextValues.GROUP;

    items.push(
      new BranchCompareGroupItem(key, repoFullPath, comparisonId, group.files, group.label, description, tooltip, group.icon, contextValue),
    );
  }

  return items;
}

/**
 * Sort a file list by the active sort order — mirrors Fresh Files'
 * `sortFilesList` so both trees order file rows identically. Basename is the tiebreaker.
 */
export function sortFilesForGrouping(files: ChangedFile[], sortOrder: SortOrder): ChangedFile[] {
  const basename = (p: string) => p.substring(p.lastIndexOf("/") + 1);
  return files.slice().sort((a, b) => {
    switch (sortOrder) {
      case "name":
        return basename(a.pathInRepo).localeCompare(basename(b.pathInRepo));
      case "author": {
        const cmp = (a.commit?.author ?? "").localeCompare(b.commit?.author ?? "");
        return cmp !== 0 ? cmp : basename(a.pathInRepo).localeCompare(basename(b.pathInRepo));
      }
      case "date":
      default: {
        const da = a.commit?.date.getTime() ?? 0;
        const db = b.commit?.date.getTime() ?? 0;
        return da !== db ? db - da : basename(a.pathInRepo).localeCompare(basename(b.pathInRepo));
      }
    }
  });
}
