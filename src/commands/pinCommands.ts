import * as vscode from "vscode";
import { FreshFileItem } from "../fresh-files/freshFileTreeItems";
import { PinnedItemsProvider } from "../fresh-files/pinnedItemsProvider";
import { AbsolutePath, asAbsolutePath } from "../pathTypes";
import { showWarning } from "../extension/logger";
import { TreeItemContextValues } from "../fresh-files/treeItemConstants";

/**
 * Pin files and folders.
 *
 * Accepts items from any tree view that exposes a `resourceUri`, including the
 * Fresh Files tree, the Branch Compare tree, and Uri-based callers (regular
 * file Explorer context menu). Group headers, whose URIs aren't `file:`, are skipped.
 */
export async function handlePinFile(
  item: FreshFileItem | vscode.Uri | TreeItemLike,
  selectedItems: (FreshFileItem | vscode.Uri | TreeItemLike)[] | undefined,
  provider: PinnedItemsProvider,
): Promise<void> {
  const items = selectedItems && selectedItems.length > 0 ? selectedItems : [item];

  const filePaths: AbsolutePath[] = [];

  for (const i of items) {
    if (i instanceof vscode.Uri) {
      // Called from regular Explorer — verify it exists before pinning.
      try {
        const stat = await vscode.workspace.fs.stat(i);
        if (stat.type & (vscode.FileType.File | vscode.FileType.Directory)) {
          filePaths.push(asAbsolutePath(i.fsPath));
        }
      } catch {
        // Skip if stat fails.
      }
    } else if (i && typeof i === "object" && "resourceUri" in i && i.resourceUri?.scheme === "file") {
      // Tree-item-like — duck-typed so any view's file and folder rows are accepted.
      filePaths.push(asAbsolutePath(i.resourceUri.fsPath));
    }
  }

  if (filePaths.length === 0) {
    showWarning("Nothing selected to pin");
    return;
  }

  provider.pinnedItemsManager.pinFiles(filePaths);
}

/** Minimal shape required for tree-item callers across the extension's views. */
interface TreeItemLike {
  resourceUri?: vscode.Uri;
}

/**
 * Unpin file(s) from the pinned items folder
 */
export function handleUnpinFile(
  item: FreshFileItem,
  selectedItems: FreshFileItem[] | undefined,
  provider: PinnedItemsProvider,
): void {
  const items = selectedItems && selectedItems.length > 0 ? selectedItems : [item];

  // Only handle pinned files — machine-created suggestions unpin (dismiss) the same way.
  const pinnedFiles = items.filter(i =>
    i.contextValue === TreeItemContextValues.PINNED_FILE
    || i.contextValue === TreeItemContextValues.PINNED_DIRECTORY
    || i.contextValue === TreeItemContextValues.SUGGESTED_FILE,
  );

  if (pinnedFiles.length === 0) {
    showWarning("No pinned items selected");
    return;
  }

  const filePaths = pinnedFiles.map(f => asAbsolutePath(f.resourceUri.fsPath));
  provider.pinnedItemsManager.unpinFiles(filePaths);
}
