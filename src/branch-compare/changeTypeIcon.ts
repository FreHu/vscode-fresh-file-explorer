import type { ChangeStatus } from "./branchCompareData";

/**
 * Codicon + theme color for a change kind, used when file rows show change
 * type instead of file type. The colors are the Source Control view's own,
 * so the tree matches the file label tint VS Code's git decorations apply.
 */
export function changeTypeIcon(status: ChangeStatus): { icon: string; color: string } {
  switch (status) {
    case "A": return { icon: "diff-added", color: "gitDecoration.addedResourceForeground" };
    case "M": return { icon: "diff-modified", color: "gitDecoration.modifiedResourceForeground" };
    case "T": return { icon: "diff-modified", color: "gitDecoration.modifiedResourceForeground" };
    case "D": return { icon: "diff-removed", color: "gitDecoration.deletedResourceForeground" };
    case "R": return { icon: "diff-renamed", color: "gitDecoration.renamedResourceForeground" };
    case "U": return { icon: "diff-added", color: "gitDecoration.untrackedResourceForeground" };
  }
}
