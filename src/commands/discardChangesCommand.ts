import * as vscode from "vscode";
import * as path from "path";

import { FreshFileProvider } from "../freshFileProvider";
import { FreshFileItem } from "../treeItems";
import { findRepoForFile } from "../types";
import { discardFileChanges, isPathWithinRoot } from "../git/gitOperations";
import { normalizePath } from "../utils";
import { log } from "../utils/logger";
import { asAbsolutePath } from "../pathTypes";

// Discard changes command - for pending files only
// SAFETY: Only discards explicitly selected files, shows full list in confirmation
export async function handleDiscardChanges(
  item: FreshFileItem,
  selectedItems: FreshFileItem[] | undefined,
  freshFileProvider: FreshFileProvider,
): Promise<void> {
  if (freshFileProvider.workspaceFolders.length === 0) {
    vscode.window.showErrorMessage("No workspace folder open");
    return;
  }

  // Get items to discard - ONLY from explicit selection, filter to pending files only
  const allItems = selectedItems && selectedItems.length > 0 ? selectedItems : item ? [item] : [];
  const pendingItems = allItems.filter(i => i && i.resourceUri && i.isPending && !i.isDirectory);

  if (pendingItems.length === 0) {
    // this is not supposed to be reachable as the discard menu action should be visible only for pending changes.
    // but perhaps a keybind could do it if there was one
    vscode.window.showInformationMessage("Discard changes is only available for modified files in pending changes.");
    return;
  }

  // Build explicit list of files for confirmation - user must see exactly what will be discarded
  const fileNames = pendingItems.map(i => path.basename(i.resourceUri.fsPath));
  const fileList =
    fileNames.length <= 5
      ? fileNames.join(", ")
      : `${fileNames.slice(0, 4).join(", ")} and ${fileNames.length - 4} more`;

  const message =
    pendingItems.length === 1
      ? `Are you sure you want to discard changes to "${fileNames[0]}"? This cannot be undone.`
      : `Are you sure you want to discard changes to ${pendingItems.length} files (${fileList})? This cannot be undone.`;

  const confirm = await vscode.window.showWarningMessage(message, { modal: true }, "Discard Changes");

  if (confirm === "Discard Changes") {
    const errors: string[] = [];
    let successCount = 0;

    for (const fileItem of pendingItems) {
      try {
        // Find workspace folder and git repo for this file
        const folder = freshFileProvider.findWorkspaceFolderForPath(asAbsolutePath(fileItem.resourceUri.fsPath));
        if (!folder) {
          log(`Could not find workspace folder for: ${fileItem.resourceUri.fsPath}`, "error");
          errors.push(path.basename(fileItem.resourceUri.fsPath) + " (no workspace folder)");
          continue;
        }

        // Security: Validate path is within workspace
        if (!isPathWithinRoot(asAbsolutePath(fileItem.resourceUri.fsPath), folder.path)) {
          log(`Security: Blocked path traversal attempt in discard: ${fileItem.resourceUri.fsPath}`, "error");
          errors.push(path.basename(fileItem.resourceUri.fsPath) + " (invalid path)");
          continue;
        }

        log(`Discarding changes: ${fileItem.resourceUri.fsPath}`);
        const relativePath = normalizePath(path.relative(folder.path, fileItem.resourceUri.fsPath));

        // Find the git repo this file belongs to
        const repoLocation = findRepoForFile(folder, relativePath);
        if (!repoLocation) {
          log(`Could not find git repository for: ${fileItem.resourceUri.fsPath}`, "error");
          errors.push(path.basename(fileItem.resourceUri.fsPath) + " (no git repo)");
          continue;
        }

        const isUntracked = fileItem.status === "??" || fileItem.status === "?";
        await discardFileChanges(repoLocation.repoFullPath, repoLocation.filePathInRepo, isUntracked);
        successCount++;
      } catch (error) {
        const fileName = path.basename(fileItem.resourceUri.fsPath);
        log(`Failed to discard changes to ${fileName}: ${error}`, "error");
        errors.push(fileName);
      }
    }

    if (errors.length > 0) {
      vscode.window.showErrorMessage(`Failed to discard: ${errors.join(", ")}`);
    }
    if (successCount > 0) {
      freshFileProvider.refresh();
    }
  }
}
