import * as vscode from "vscode";

import { FreshFileItem, FreshFilesTreeItem } from "../treeItems";
import { FreshFileProvider } from "../freshFileProvider";
import { log, showOutputChannel } from "../utils/logger";
import { expandItemRecursively } from "../utils/treeUtils";
import { createTimeWindowQuickPick } from "../utils/quickPick";

export function handleRefresh(freshFileProvider: FreshFileProvider): void {
  log("Refresh command triggered");
  freshFileProvider.refresh();
}

export async function handleInitializeRepo(freshFileProvider: FreshFileProvider): Promise<void> {
  log("Initialize repository command triggered");

  // Check if we have a workspace folder
  if (freshFileProvider.workspaceFolders.length === 0) {
    vscode.window.showErrorMessage("No workspace folder open");
    return;
  }

  // If single folder, initialize there. If multiple, ask which one.
  let targetFolder = freshFileProvider.workspaceFolders[0];
  if (freshFileProvider.workspaceFolders.length > 1) {
    const selected = await vscode.window.showQuickPick(
      freshFileProvider.workspaceFolders.map(f => ({
        label: f.name,
        description: f.path,
        folder: f,
      })),
      { placeHolder: "Select folder to initialize as Git repository" },
    );
    if (!selected) {
      return; // User cancelled
    }
    targetFolder = selected.folder;
  }

  // Run git init
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFilePromise = promisify(execFile);

    await execFilePromise("git", ["init"], { cwd: targetFolder.path });
    log(`Initialized Git repository in ${targetFolder.name}`);
    vscode.window.showInformationMessage(`Git repository initialized in ${targetFolder.name}`);

    // Refresh to discover the new repo
    freshFileProvider.refresh();
  } catch (error) {
    const errorMsg = String(error);
    log(`Failed to initialize Git repository: ${errorMsg}`, "error");
    vscode.window.showErrorMessage(`Failed to initialize Git repository: ${errorMsg}`);
  }
}

export async function handleSetTimeWindow(freshFileProvider: FreshFileProvider): Promise<void> {
  log("Set time window command triggered");
  const quickPick = createTimeWindowQuickPick(freshFileProvider.timeWindows, freshFileProvider.currentTimeWindow);

  quickPick.onDidAccept(() => {
    const selected = quickPick.selectedItems[0];
    if (selected && selected.timeWindow !== freshFileProvider.currentTimeWindow) {
      freshFileProvider.setTimeWindow(selected.timeWindow);
    }
    quickPick.hide();
  });

  quickPick.show();
}

export function handleShowOutput(): void {
  showOutputChannel();
}

export async function handleExpandAll(
  freshFileProvider: FreshFileProvider,
  treeView: vscode.TreeView<FreshFilesTreeItem>,
): Promise<void> {
  log("Expand all command triggered");
  const rootItems = await freshFileProvider.getChildren();
  for (const item of rootItems) {
    if (item instanceof FreshFileItem && item.isDirectory) {
      await expandItemRecursively(treeView, freshFileProvider, item);
    }
  }
}

export async function handleExpandSubtree(
  item: FreshFileItem,
  treeView: vscode.TreeView<FreshFilesTreeItem>,
  freshFileProvider: FreshFileProvider,
): Promise<void> {
  if (!item || !item.isDirectory) {
    return;
  }
  log(`Expand subtree command triggered for: ${item.resourceUri.fsPath}`);
  try {
    await expandItemRecursively(treeView, freshFileProvider, item);
  } catch (error) {
    log(`Expand subtree encountered an error: ${error}`, "warn");
  }
}

export function handleRevealInExplorer(item: FreshFileItem, selectedItems?: FreshFileItem[]): void {
  const target = item || selectedItems?.[0];
  if (target && target.resourceUri) {
    log(`Revealing in explorer: ${target.resourceUri.fsPath}`);
    vscode.commands.executeCommand("revealInExplorer", target.resourceUri);
  }
}

export async function handleOpenFile(
  item: FreshFileItem,
  selectedItems?: FreshFileItem[],
  options?: { preserveFocus?: boolean },
): Promise<void> {
  const items = selectedItems && selectedItems.length > 0 ? selectedItems : item ? [item] : [];
  const preserveFocus = options?.preserveFocus ?? false;
  for (const fileItem of items.filter(isPossibleToOpen)) {
    vscode.commands.executeCommand("vscode.open", fileItem.resourceUri, {
      preserveFocus,
      preview: preserveFocus,
    });
  }
}

/**
 * Handler for toggling open mode (file vs changes/diff)
 */
export function handleToggleOpenMode(freshFileProvider: FreshFileProvider): void {
  freshFileProvider.toggleOpenMode();
}

export async function handleOpenToSide(item: FreshFileItem, selectedItems?: FreshFileItem[]): Promise<void> {
  const items = selectedItems && selectedItems.length > 0 ? selectedItems : item ? [item] : [];
  for (const fileItem of items.filter(isPossibleToOpen)) {
    vscode.commands.executeCommand("vscode.open", fileItem.resourceUri, vscode.ViewColumn.Beside);
  }
}

export function isPossibleToOpen(item: FreshFileItem) {
  return item && item.resourceUri && !item.isDirectory;
}

export function handleRevealInSourceControl(item: FreshFileItem, selectedItems?: FreshFileItem[]): void {
  const target = item || selectedItems?.[0];
  if (target && target.resourceUri) {
    log(`Revealing in source control: ${target.resourceUri.fsPath}`);
    // Focus the Source Control view and reveal the file
    vscode.commands.executeCommand("workbench.view.scm");
    // The git extension should highlight the file when SCM view opens with the file selected
    vscode.commands.executeCommand("git.openFile", target.resourceUri);
  }
}
