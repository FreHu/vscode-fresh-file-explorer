import * as vscode from "vscode";
import { FreshFileItem } from "../fresh-files/freshFileTreeItems";
import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { AbsolutePath, asAbsolutePath } from "../pathTypes";
import { showWarning } from "../extension/logger";

/**
 * Pin file(s) to the pinned items folder
 * Can be called from Fresh Files view with FreshFileItem(s) or from Explorer with Uri(s)
 */
export async function handlePinFile(
  item: FreshFileItem | vscode.Uri,
  selectedItems: (FreshFileItem | vscode.Uri)[] | undefined,
  provider: FreshFileProvider,
): Promise<void> {
  const items = selectedItems && selectedItems.length > 0 ? selectedItems : [item];

  // Convert items to file paths
  const filePaths: AbsolutePath[] = [];

  for (const i of items) {
    if (i instanceof vscode.Uri) {
      // Called from explorer - check if it's a file
      try {
        const stat = await vscode.workspace.fs.stat(i);
        if (stat.type === vscode.FileType.File) {
          filePaths.push(asAbsolutePath(i.fsPath));
        }
      } catch {
        // Skip if stat fails
      }
    } else if (i instanceof FreshFileItem) {
      // Called from Fresh Files view
      if (!i.isDirectory && i.contextValue !== "pinnedFolder") {
        filePaths.push(asAbsolutePath(i.resourceUri.fsPath));
      }
    }
  }

  if (filePaths.length === 0) {
    showWarning("No files selected to pin");
    return;
  }

  provider.pinFiles(filePaths);
}

/**
 * Unpin file(s) from the pinned items folder
 */
export function handleUnpinFile(
  item: FreshFileItem,
  selectedItems: FreshFileItem[] | undefined,
  provider: FreshFileProvider,
): void {
  const items = selectedItems && selectedItems.length > 0 ? selectedItems : [item];

  // Only handle pinned files
  const pinnedFiles = items.filter(i => i.contextValue === "pinnedFile");

  if (pinnedFiles.length === 0) {
    showWarning("No pinned files selected");
    return;
  }

  const filePaths = pinnedFiles.map(f => asAbsolutePath(f.resourceUri.fsPath));
  provider.unpinFiles(filePaths);
}
