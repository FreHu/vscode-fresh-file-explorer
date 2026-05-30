import * as vscode from "vscode";
import { FreshFileItem } from "../fresh-files/freshFileTreeItems";
import { PinnedItemsProvider } from "../fresh-files/pinnedItemsProvider";
import { AbsolutePath, asAbsolutePath } from "../pathTypes";
import { showWarning } from "../extension/logger";
import { TreeItemContextValues } from "../fresh-files/treeItemConstants";

/**
 * Pin file(s) to the pinned items folder.
 *
 * Accepts items from any tree view that exposes `{resourceUri, isDirectory}`,
 * including the Fresh Files tree, the Branch Compare tree, and Uri-based
 * callers (regular file Explorer context menu). Folders and the special
 * "pinned folder" header are skipped.
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
      // Called from regular Explorer — verify it's a file before pinning.
      try {
        const stat = await vscode.workspace.fs.stat(i);
        if (stat.type === vscode.FileType.File) {
          filePaths.push(asAbsolutePath(i.fsPath));
        }
      } catch {
        // Skip if stat fails.
      }
    } else if (i && typeof i === "object" && "resourceUri" in i && i.resourceUri) {
      // Tree-item-like — duck-typed so any view's items are accepted as long
      // as they expose a resourceUri and aren't directories or pin-folder headers.
      if (!i.isDirectory && i.contextValue !== "pinnedFolder") {
        filePaths.push(asAbsolutePath(i.resourceUri.fsPath));
      }
    }
  }

  if (filePaths.length === 0) {
    showWarning("No files selected to pin");
    return;
  }

  provider.pinnedItemsManager.pinFiles(filePaths);
}

/** Minimal shape required for tree-item callers across the extension's views. */
interface TreeItemLike {
  resourceUri?: vscode.Uri;
  isDirectory?: boolean;
  contextValue?: string;
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

  // Only handle pinned files
  const pinnedFiles = items.filter(i => i.contextValue === TreeItemContextValues.PINNED_FILE);

  if (pinnedFiles.length === 0) {
    showWarning("No pinned files selected");
    return;
  }

  const filePaths = pinnedFiles.map(f => asAbsolutePath(f.resourceUri.fsPath));
  provider.pinnedItemsManager.unpinFiles(filePaths);
}
