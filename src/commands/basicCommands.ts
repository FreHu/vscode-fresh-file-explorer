import * as vscode from "vscode";
import * as path from "path";

import { FreshFileItem, FreshFilesTreeItem } from "../fresh-files/freshFileTreeItems";
import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { log, showOutputChannel } from "../extension/logger";
import { expandItemRecursively } from "../utils/treeUtils";
import { createTimeWindowQuickPick } from "../utils/quickPick";
import { GROUPING_MODE_OPTIONS, GroupingMode } from "../fresh-files/groupingMode";
import { SortOrder } from "../types";
import { openFileWithoutDuplicating } from "../utils";

export function handleRefresh(freshFileProvider: FreshFileProvider): void {
  log("Refresh command triggered");
  freshFileProvider.hardRefresh();
}

export async function handleSetTimeWindow(freshFileProvider: FreshFileProvider): Promise<void> {
  log("Set time window command triggered");
  const originalTimeWindow = freshFileProvider.currentTimeWindow;
  const quickPick = createTimeWindowQuickPick(freshFileProvider.timeWindows, freshFileProvider.currentTimeWindow);

  let accepted = false;

  quickPick.onDidChangeActive(items => {
    const item = items[0];
    if (item && item.timeWindow !== freshFileProvider.currentTimeWindow) {
      freshFileProvider.setTimeWindow(item.timeWindow);
    }
  });

  quickPick.onDidAccept(() => {
    accepted = true;
    quickPick.hide();
  });

  quickPick.onDidHide(() => {
    if (!accepted) {
      freshFileProvider.setTimeWindow(originalTimeWindow);
    }
    quickPick.dispose();
  });

  quickPick.show();
}

export async function handleSetGroupingMode(freshFileProvider: FreshFileProvider): Promise<boolean> {
  log("Set grouping mode command triggered");

  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick();
    quickPick.title = "Select Grouping Mode";
    quickPick.placeholder = "Choose how to organize files in the tree";

    quickPick.items = GROUPING_MODE_OPTIONS.map(option => ({
      label: `${option.icon} ${option.label}`,
      description: option.description,
      mode: option.mode,
      // Mark current mode with check mark
      picked: option.mode === freshFileProvider.groupingMode,
    }));

    let resolved = false;

    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems[0] as any;
      if (selected && selected.mode !== freshFileProvider.groupingMode) {
        freshFileProvider.setGroupingMode(selected.mode as GroupingMode);
      }
      quickPick.hide();
      if (!resolved) {
        resolved = true;
        resolve(true); // Selection made
      }
    });

    quickPick.onDidHide(() => {
      if (!resolved) {
        resolved = true;
        resolve(false); // Cancelled
      }
      quickPick.dispose();
    });

    quickPick.show();
  });
}

export async function handleSetSortOrder(freshFileProvider: FreshFileProvider): Promise<boolean> {
  log("Set sort order command triggered");

  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick();
    quickPick.title = "Select Sort Order";
    quickPick.placeholder = "Choose how to sort files within folders";

    const sortOptions = [
      {
        label: "$(symbol-text) Name (A-Z)",
        description: "Sort alphabetically by filename",
        order: "name" as SortOrder,
      },
      {
        label: "$(calendar) Date (Newest First)",
        description: "Sort by commit date, most recent first",
        order: "date" as SortOrder,
      },
      {
        label: "$(person) Author (A-Z)",
        description: "Sort alphabetically by commit author",
        order: "author" as SortOrder,
      },
    ];

    quickPick.items = sortOptions.map(option => ({
      label: option.label,
      description: option.description,
      order: option.order,
      // Mark current sort order with check mark
      picked: option.order === freshFileProvider.sortOrder,
    }));

    let resolved = false;

    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems[0] as any;
      if (selected && selected.order !== freshFileProvider.sortOrder) {
        freshFileProvider.setSortOrder(selected.order as SortOrder);
      }
      quickPick.hide();
      if (!resolved) {
        resolved = true;
        resolve(true); // Selection made
      }
    });

    quickPick.onDidHide(() => {
      if (!resolved) {
        resolved = true;
        resolve(false); // Cancelled
      }
      quickPick.dispose();
    });

    quickPick.show();
  });
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
    await openFileWithoutDuplicating(fileItem.resourceUri, {
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
    await openFileWithoutDuplicating(fileItem.resourceUri, {
      viewColumn: vscode.ViewColumn.Beside,
    });
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

export async function handleDeleteFile(
  item: FreshFileItem,
  selectedItems: FreshFileItem[] | undefined,
  freshFileProvider: FreshFileProvider,
  treeView?: vscode.TreeView<FreshFilesTreeItem>,
): Promise<void> {
  // When triggered via keybinding, item and selectedItems are undefined.
  // Fall back to the tree view's current selection.
  const treeSelection = treeView?.selection.filter((i): i is FreshFileItem => i instanceof FreshFileItem);
  const allItems = selectedItems && selectedItems.length > 0 ? selectedItems
    : item ? [item]
    : treeSelection && treeSelection.length > 0 ? treeSelection
    : [];
  // Only delete actual on-disk files — skip deleted files (they don't exist) and directories
  const targets = allItems.filter(i => i && i.resourceUri && !i.isDeleted && !i.isDirectory);

  if (targets.length === 0) {
    return;
  }

  const fileNames = targets.map(i => path.basename(i.resourceUri.fsPath));

  const message =
    targets.length === 1
      ? `Are you sure you want to delete this file?`
      : `Are you sure you want to delete ${targets.length} files?`;

  const fileList = fileNames.map(name => `  • ${name}`).join("\n");
  const detail = `${fileList}\n\nThe file(s) will be moved to the trash.`;

  const confirm = await vscode.window.showWarningMessage(
    message,
    { modal: true, detail },
    "Delete",
  );

  if (confirm !== "Delete") {
    return;
  }

  const errors: string[] = [];
  let successCount = 0;

  for (const fileItem of targets) {
    try {
      log(`Deleting file: ${fileItem.resourceUri.fsPath}`);
      await vscode.workspace.fs.delete(fileItem.resourceUri, { useTrash: true });
      successCount++;
    } catch (error) {
      const fileName = path.basename(fileItem.resourceUri.fsPath);
      log(`Failed to delete ${fileName}: ${error}`, "error");
      errors.push(fileName);
    }
  }

  if (errors.length > 0) {
    vscode.window.showErrorMessage(`Failed to delete: ${errors.join(", ")}`);
  }
  if (successCount > 0) {
    freshFileProvider.refreshPending();
  }
}

export async function handleToggleHeatmap(freshFileProvider: FreshFileProvider): Promise<void> {
  const config = vscode.workspace.getConfiguration();
  const currentValue = config.get<boolean>("freshFileExplorer.heatmap.enabled", true);
  const newValue = !currentValue;
  
  await config.update("freshFileExplorer.heatmap.enabled", newValue, vscode.ConfigurationTarget.Global);
  
  log(`Heatmap ${newValue ? "enabled" : "disabled"}`);
  
  // Notify the heatmap provider to refresh decorations
  freshFileProvider.heatmapProvider?.fireDidChange();
}
