import * as vscode from "vscode";
import * as path from "path";

import { ChangedFile, ChangeStatus, FolderNode } from "./branchCompareData";
import { Commands } from "../commands/commandConstants";
import { AbsolutePath } from "../pathTypes";
import { BranchCompareContextValues, DiffMode } from "./branchCompareConstants";
import { formatLineChanges } from "../utils/formatUtils";

/** Single-letter status badge shown in the description column. */
function statusBadge(status: ChangeStatus): string {
  switch (status) {
    case "A": return "A";
    case "M": return "M";
    case "D": return "D";
    case "R": return "R";
    case "T": return "T";
    case "U": return "U";
  }
}

function statusTooltip(status: ChangeStatus, isPending: boolean): string {
  const verb = (() => {
    switch (status) {
      case "A": return "added";
      case "M": return "modified";
      case "D": return "deleted";
      case "R": return "renamed";
      case "T": return "type changed";
      case "U": return "untracked";
    }
  })();
  return isPending ? `${verb} (working tree)` : verb;
}

/**
 * Tree item representing a section in the Branch Compare view. One per
 * **active saved comparison** — multiple sections can share the same repo
 * (one per comparison id). The header label is the user-given comparison
 * name, falling back to `repoName · source..target`.
 */
export class RepoSectionItem extends vscode.TreeItem {
  readonly kind = "repoSection" as const;
  constructor(
    public readonly repoFullPath: AbsolutePath,
    public readonly repoName: string,
    public readonly targetRef: string,
    public readonly fileCount: number,
    expanded: boolean,
    /** Current HEAD branch name. Optional — undefined when git API hasn't reported it yet. */
    public readonly currentBranch?: string,
    /** Persisted comparison id (from SavedComparisonsService) — used by the provider to look up state. */
    public readonly comparisonId?: string,
    /** Total vs first-parent commit counts. Set when the cone fans out via merges — surfaces a tooltip hint. */
    mergeCone?: { total: number; firstParent: number },
    /** Diff mode of this comparison. `full` is surfaced so same-ref sections that differ only by mode stay distinguishable. */
    diffMode: DiffMode = "merge",
    /** True for auto-follow sections — distinct icon + contextValue (carries "Stop following"). */
    auto = false,
    /** Whether reviewed files are hidden for this comparison — surfaced as a tooltip hint. */
    hideReviewed = false,
    /** How many of `fileCount` are marked reviewed. Only surfaced when `hideReviewed` is on — otherwise the plain count is unambiguous. */
    reviewedCount = 0,
  ) {
    // Always expandable — even an empty section renders a "No changes / Loading…"
    // message child, which is meaningful to show. More importantly, VS Code's
    // TreeView locks in collapsibleState on first render by item id; using
    // `None` while data is still loading would freeze the section closed even
    // after data arrives.
    super(
      repoName,
      expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    // Section id incorporates the comparison id when one is provided so VS
    // Code's TreeView treats multiple comparisons for the same repo as
    // distinct items.
    this.id = comparisonId
      ? `branchCompare:section:${comparisonId}`
      : `branchCompare:repo:${repoFullPath}`;
    // `full` is the non-default mode, so flag it in the description; that also
    // keeps two same-ref sections (one merge, one full) visually distinct.
    const modeSuffix = diffMode === "full" ? " · full" : "";
    // Hiding reviewed files makes the tree show fewer rows than `fileCount` - surface the reviewed count too
    const showReviewedCount = hideReviewed && reviewedCount > 0;
    const changesText = fileCount === 0
      ? " · no changes"
      : showReviewedCount
        ? ` · ${fileCount} changes, ${reviewedCount} reviewed`
        : ` · ${fileCount} changes`;
    this.description = `${changesText}${modeSuffix}`;
    const tooltipLines = [repoName];
    if (currentBranch) {
      tooltipLines.push(`Current branch: ${currentBranch}`);
    }
    tooltipLines.push(
      showReviewedCount
        ? `${fileCount} changed file(s), ${reviewedCount} reviewed`
        : `${fileCount} changed file(s)`,
    );
    if (diffMode === "full") {
      tooltipLines.push("Full diff (against the target ref, not the merge-base)");
    }
    if (mergeCone && mergeCone.total > mergeCone.firstParent) {
      const broughtIn = mergeCone.total - mergeCone.firstParent;
      tooltipLines.push(
        `${mergeCone.firstParent} commit(s) on this line, ${broughtIn} brought in via merges`,
      );
    }
    if (auto) {
      tooltipLines.push("Auto-following this branch — diff updates live");
    }
    if (hideReviewed) {
      tooltipLines.push("Hiding reviewed files");
    }
    this.tooltip = tooltipLines.join("\n");
    // Auto-follow sections get the "eye" (watching) icon and a distinct
    // contextValue so the "Stop following" action can target only them.
    this.iconPath = new vscode.ThemeIcon(auto ? "eye" : "repo");
    this.contextValue = auto
      ? BranchCompareContextValues.AUTO_REPO_SECTION
      : BranchCompareContextValues.REPO_SECTION;
  }
}

/** Folder node inside a repo section. */
export class BranchCompareFolderItem extends vscode.TreeItem {
  readonly kind = "folder" as const;
  /** Mirrors `FreshFileItem.isDirectory` so commands that branch on this property work uniformly. */
  readonly isDirectory = true;
  constructor(
    public readonly repoFullPath: AbsolutePath,
    public readonly node: FolderNode,
    public readonly fileCount: number,
    expanded: boolean,
    /** The comparison this folder belongs to — needed to route commands to the right baseline when multiple comparisons exist in the same repo. */
    public readonly comparisonId: string,
    /** True when every file under this folder is marked reviewed */
    reviewed = false,
  ) {
    const folderUri = vscode.Uri.file(path.join(repoFullPath, node.pathInRepo));
    super(
      folderUri,
      expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    // Scope the id to the comparison so VS Code's TreeView tracks expansion
    // state separately when the same repo path appears under multiple
    // comparisons.
    this.id = `branchCompare:folder:${comparisonId}:${node.pathInRepo}`;
    this.label = node.name;
    if (fileCount > 0) {
      this.description = `(${fileCount})`;
    }
    this.contextValue = BranchCompareContextValues.FOLDER;
    this.resourceUri = folderUri;
    this.checkboxState = reviewed
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
  }
}

/** File node — clicking opens the diff (vs baseline). */
export class BranchCompareFileItem extends vscode.TreeItem {
  readonly kind = "file" as const;
  /** Mirrors `FreshFileItem.isDirectory` so commands that branch on this property work uniformly. */
  readonly isDirectory = false;
  constructor(
    public readonly file: ChangedFile,
    /** The "source" side of the comparison — `"HEAD"` means working tree, anything else is a specific ref's content. */
    public readonly sourceRef: string,
    public readonly targetRef: string,
    /** The comparison this file belongs to — needed so the same path under two comparisons stays distinguishable. */
    public readonly comparisonId: string,
    /** Diff mode of the owning comparison — decides whether the open path diffs vs the merge-base or the target ref. */
    public readonly diffMode: DiffMode = "merge",
    /** Left-click mode: `true` opens the diff, `false` opens the working-tree file. */
    openChangesMode: boolean = true,
    /** Whether this file is marked reviewed for this comparison — drives the checkbox. */
    reviewed = false,
  ) {
    const uri = vscode.Uri.file(file.absolutePath);
    super(uri, vscode.TreeItemCollapsibleState.None);
    this.id = `branchCompare:file:${comparisonId}:${file.absolutePath}`;
    this.resourceUri = uri;
    this.checkboxState = reviewed
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;

    // Pending entries are skipped:
    // VS Code's native git decoration already badges them
    const badge = file.isPending ? "" : statusBadge(file.status);
    const pendingMark = file.isPending ? "•" : "";
    // Line deltas exist only for pending entries (tracked working-tree changes).
    const lineChanges = formatLineChanges(file.linesAdded, file.linesDeleted);
    this.description = `${badge}${pendingMark}${lineChanges ? ` ${lineChanges}` : ""}`;
    this.tooltip = `${file.pathInRepo}\n${statusTooltip(file.status, file.isPending)}`
      + (lineChanges ? `\n${lineChanges}` : "")
      + (file.renameSource ? `\nfrom: ${file.renameSource}` : "")
      + `\nbaseline: ${targetRef}`;

    if (file.status === "D") {
      this.contextValue = BranchCompareContextValues.FILE_DELETED;
      this.iconPath = new vscode.ThemeIcon("trash", new vscode.ThemeColor("errorForeground"));
      // Deleted file: clicking opens the baseline content (read-only).
      this.command = {
        command: Commands.BRANCH_COMPARE_OPEN,
        title: "Open Baseline",
        arguments: [this],
      };
    } else {
      this.contextValue = BranchCompareContextValues.FILE;
      // Open mode decides the click target: the diff vs baseline, or the file.
      this.command = openChangesMode
        ? { command: Commands.BRANCH_COMPARE_OPEN, title: "Open Changes", arguments: [this] }
        : { command: Commands.BRANCH_COMPARE_OPEN_FILE, title: "Open File", arguments: [this] };
    }
  }
}

/** Lightweight informational row, e.g. when a repo has zero changes. */
export class BranchCompareMessageItem extends vscode.TreeItem {
  readonly kind = "message" as const;
  constructor(message: string, icon?: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = BranchCompareContextValues.MESSAGE;
    if (icon) {
      this.iconPath = new vscode.ThemeIcon(icon);
    }
  }
}

// Group items live in a separate file (branchCompareGroupingBuilder.ts) but
// participate in the same tree. We declare them here as a structural slot so
// the provider's `BranchCompareTreeItem` union covers them without forcing a
// circular import.
export interface BranchCompareGroupItemLike extends vscode.TreeItem {
  readonly kind: "group";
}

export type BranchCompareTreeItem =
  | RepoSectionItem
  | BranchCompareFolderItem
  | BranchCompareFileItem
  | BranchCompareMessageItem
  | BranchCompareGroupItemLike;
