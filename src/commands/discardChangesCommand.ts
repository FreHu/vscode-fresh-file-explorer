import * as vscode from "vscode";
import * as path from "path";

import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { FreshFileItem } from "../fresh-files/freshFileTreeItems";
import { findRepoForFile, isPathWithinRoot, findWorkspaceFolderForPath, findRepoPathsForFiles } from "../utils/pathUtils";
import {
  discardFileChanges,
  discardAllFileChanges,
  unstageFile,
  hasStagedChanges,
  hasUnstagedChanges,
} from "../git/gitOperations";
import { normalizePath } from "../utils";
import { log, showError, showInfo } from "../extension/logger";
import { asAbsolutePath } from "../pathTypes";

type DiscardAction = "everything" | "discard-unstaged-only" | "unstage-only";

/**
 * Classifies pending items by their staged/unstaged state.
 */
function classifyPendingItems(items: FreshFileItem[]): {
  stagedItems: FreshFileItem[];
  hasAnyStaged: boolean;
  hasAnyUnstaged: boolean;
} {
  const stagedItems = items.filter(i => hasStagedChanges(i.status ?? ""));
  const hasAnyStaged = stagedItems.length > 0;
  const hasAnyUnstaged = items.some(i => {
    const s = i.status ?? "";
    return hasUnstagedChanges(s) || s === "??" || s === "?";
  });

  return { stagedItems, hasAnyStaged, hasAnyUnstaged };
}

async function promptForAction(
  pendingItems: FreshFileItem[],
  stagedItems: FreshFileItem[],
  hasAnyStaged: boolean,
  hasAnyUnstaged: boolean,
): Promise<DiscardAction | null> {
  if (!hasAnyStaged) {
    return await promptSimpleConfirmation(pendingItems);
  } else {
    return await promptStagedConfirmation(pendingItems, stagedItems, hasAnyUnstaged);
  }
}

/**
 * Simple confirmation for files with no staged changes.
 */
async function promptSimpleConfirmation(pendingItems: FreshFileItem[]): Promise<DiscardAction | null> {
  const fileNames = pendingItems.map(i => path.basename(i.resourceUri.fsPath));

  const message =
    pendingItems.length === 1
      ? `Are you sure you want to discard changes to "${fileNames[0]}"? This cannot be undone.`
      : `Are you sure you want to discard changes to these ${pendingItems.length} files? This cannot be undone.`;

  const detail = pendingItems.length > 1
    ? fileNames.map(n => `  • ${n}`).join("\n")
    : undefined;

  const confirm = await vscode.window.showWarningMessage(message, { modal: true, detail }, "Discard Changes");
  return confirm === "Discard Changes" ? "everything" : null;
}

/**
 * Modal confirmation for files with staged changes.
 * Offers Unstage Only, Discard Unstaged Only (if applicable), or Discard Everything.
 */
async function promptStagedConfirmation(
  pendingItems: FreshFileItem[],
  stagedItems: FreshFileItem[],
  hasAnyUnstaged: boolean,
): Promise<DiscardAction | null> {
  const stagedCount = stagedItems.length;
  const stagedFileLines = stagedItems.map(i => `  • ${path.basename(i.resourceUri.fsPath)}`).join("\n");
  const stagedSummary =
    stagedCount === pendingItems.length
      ? pendingItems.length === 1 ? "This file has staged changes:" : "All files have staged changes:"
      : `${stagedCount} of ${pendingItems.length} files have staged changes:`;

  const detailLines = [
    stagedSummary,
    stagedFileLines,
    "",
    "Unstage Only: moves staged changes back to the working tree.",
    ...(hasAnyUnstaged ? ["Discard Unstaged Only: keeps staged changes, discards working-tree edits (cannot be undone)."] : []),
    "Discard Everything: resets all selected files to HEAD (cannot be undone).",
  ];

  // Build button list — safest action first
  const buttons: string[] = ["Unstage Only"];
  if (hasAnyUnstaged) {
    buttons.push("Discard Unstaged Only");
  }
  buttons.push("Discard Everything");

  const choice = await vscode.window.showWarningMessage(
    "Some files have staged changes. How would you like to proceed?",
    { modal: true, detail: detailLines.join("\n") },
    ...buttons,
  );

  if (!choice) {
    return null;
  }
  return choice === "Discard Everything" ? "everything"
    : choice === "Discard Unstaged Only" ? "discard-unstaged-only"
      : "unstage-only";
}

/**
 * Executes the "discard everything" action on a file.
 * Restores the file to HEAD state (both index and working tree).
 */
async function executeDiscardEverything(
  repoLocation: any,
  status: string,
  filePath: string,
): Promise<boolean> {
  const isUntracked = status === "??" || status === "?";
  const staged = hasStagedChanges(status);

  if (isUntracked) {
    await discardFileChanges(repoLocation.repoFullPath, filePath, true);
  } else if (staged) {
    // Has staged changes: reset both index and working tree to HEAD
    await discardAllFileChanges(repoLocation.repoFullPath, filePath);
  } else {
    // Unstaged only: restore working tree from index
    await discardFileChanges(repoLocation.repoFullPath, filePath, false);
  }

  return true;
}

/**
 * Executes the "discard unstaged only" action on a file.
 * Restores working-tree changes, preserving staged changes.
 */
async function executeDiscardUnstagedOnly(
  repoLocation: any,
  status: string,
  filePath: string,
  fileDisplayPath: string,
): Promise<boolean> {
  const isUntracked = status === "??" || status === "?";
  const unstaged = hasUnstagedChanges(status);

  if (isUntracked || unstaged) {
    await discardFileChanges(repoLocation.repoFullPath, filePath, isUntracked);
    return true;
  } else {
    // Staged-only: no working-tree changes to discard
    log(`Skipping staged-only file for "discard-unstaged-only" action: ${fileDisplayPath}`);
    return false;
  }
}

/**
 * Executes the "unstage only" action on a file.
 * Moves staged changes back to the working tree.
 */
async function executeUnstageOnly(
  repoLocation: any,
  status: string,
  filePath: string,
  fileDisplayPath: string,
): Promise<boolean> {
  const staged = hasStagedChanges(status);

  if (staged) {
    await unstageFile(repoLocation.repoFullPath, filePath);
    return true;
  } else {
    // discard-unstaged-only or untracked: nothing to unstage
    log(`Skipping non-staged file for "unstage-only" action: ${fileDisplayPath}`);
    return false;
  }
}

/**
 * Executes a discard action on a single file.
 */
async function executeDiscardAction(
  fileItem: FreshFileItem,
  repoLocation: any,
  action: DiscardAction,
): Promise<boolean> {
  const status = fileItem.status ?? "";

  log(`Discarding changes (action=${action}, status="${status}"): ${fileItem.resourceUri.fsPath}`);

  if (action === "everything") {
    return await executeDiscardEverything(repoLocation, status, repoLocation.filePathInRepo);
  } else if (action === "discard-unstaged-only") {
    return await executeDiscardUnstagedOnly(repoLocation, status, repoLocation.filePathInRepo, fileItem.resourceUri.fsPath);
  } else if(action === "unstage-only") {
    return await executeUnstageOnly(repoLocation, status, repoLocation.filePathInRepo, fileItem.resourceUri.fsPath);
  }

  return false;
}

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
    showInfo("Discard changes is only available for modified files in pending changes.");
    return;
  }

  // Classify items by staged/unstaged state
  const { stagedItems, hasAnyStaged, hasAnyUnstaged } = classifyPendingItems(pendingItems);

  // Prompt user for action
  const action = await promptForAction(pendingItems, stagedItems, hasAnyStaged, hasAnyUnstaged);
  if (!action) {
    return;
  }

  // Execute the chosen action for each file
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

      const relativePath = normalizePath(path.relative(folder.path, fileItem.resourceUri.fsPath));

      // Find the git repo this file belongs to
      const repoLocation = findRepoForFile(folder, relativePath);
      if (!repoLocation) {
        log(`Could not find git repository for: ${fileItem.resourceUri.fsPath}`, "error");
        errors.push(path.basename(fileItem.resourceUri.fsPath) + " (no git repo)");
        continue;
      }

      const performed = await executeDiscardAction(fileItem, repoLocation, action);

      if (performed) {
        const status = fileItem.status ?? "";
        const isUntracked = status === "??" || status === "?";
        if (isUntracked) {
          anyUntrackedDiscarded = true;
        }
        successCount++;
      }
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
    const repoPaths = findRepoPathsForFiles(freshFileProvider.workspaceFolders, pendingItems.map(i => i.resourceUri.fsPath));
    const targetRepoPaths = repoPaths.length > 0 ? repoPaths : undefined;
    // Discarding an untracked file removes it from disk, which can change the isDeleted
    // determination of its historical entry in the cache. A full refresh is required
    // to correctly restore the deleted-file state (icon, context menu, resurrect option).
    if (anyUntrackedDiscarded) {
      freshFileProvider.refresh({ targetRepoPaths });
    } else {
      freshFileProvider.refreshPending(targetRepoPaths);
    }
  }
}

