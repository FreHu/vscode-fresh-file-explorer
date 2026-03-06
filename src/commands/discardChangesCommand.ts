import * as vscode from "vscode";
import * as path from "path";

import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { FreshFileItem } from "../fresh-files/freshFileTreeItems";
import { findRepoForFile } from "../types";
import { discardFileChanges } from "../git/gitOperations";
import { isPathWithinRoot } from "../utils/pathUtils";
import { normalizePath } from "../utils";
import { log, showError, showInfo } from "../extension/logger";
import { asAbsolutePath } from "../pathTypes";
import { findWorkspaceFolderForPath } from "../utils/pathUtils";

// Discard changes command - for pending files only
// SAFETY: Only discards explicitly selected files, shows full list in confirmation
export async function handleDiscardChanges(
  item: FreshFileItem,
  selectedItems: FreshFileItem[] | undefined,
  freshFileProvider: FreshFileProvider,
): Promise<void> {

  if (freshFileProvider.warnIfNoWorkspaceFolders()) return undefined;

  // Get items to discard - ONLY from explicit selection, filter to pending files only
  const allItems = selectedItems && selectedItems.length > 0 ? selectedItems : item ? [item] : [];
  const pendingItems = allItems.filter(i => i && i.resourceUri && i.isPending && !i.isDirectory);

  if (pendingItems.length === 0) {
    // this is not supposed to be reachable as the discard menu action should be visible only for pending changes.
    // but perhaps a keybind could do it if there was one
    showInfo("Discard changes is only available for modified files in pending changes.");
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
    let anyUntrackedDiscarded = false;

    for (const fileItem of pendingItems) {
      try {
        // Find workspace folder and git repo for this file
        const folder = findWorkspaceFolderForPath(asAbsolutePath(fileItem.resourceUri.fsPath), freshFileProvider.workspaceFolders);
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
        if (isUntracked) {
          anyUntrackedDiscarded = true;
        }
        successCount++;
      } catch (error) {
        const fileName = path.basename(fileItem.resourceUri.fsPath);
        log(`Failed to discard changes to ${fileName}: ${error}`, "error");
        errors.push(fileName);
      }
    }

    if (errors.length > 0) {
      showError(`Failed to discard: ${errors.join(", ")}`);
    }
    if (successCount > 0) {
      // Discarding an untracked file removes it from disk, which can change the isDeleted
      // determination of its historical entry in the cache. A full refresh is required
      // to correctly restore the deleted-file state (icon, context menu, resurrect option).
      if (anyUntrackedDiscarded) {
        freshFileProvider.refresh();
      } else {
        freshFileProvider.refreshPending();
      }
    }
  }
}
