import * as vscode from "vscode";

import { FreshFileItem, FreshFilesTreeItem } from "../treeItems";
import { FreshFileProvider } from "../freshFileProvider";
import { log, showOutputChannel } from "../utils/logger";
import { expandItemRecursively } from "../utils/treeUtils";
import { createTimeWindowQuickPick } from "../utils/quickPick";
import { GROUPING_MODE_OPTIONS, GroupingMode } from "../groupingMode";
import { SortOrder } from "../types";
import { openFileWithoutDuplicating } from "../utils";

export function handleRefresh(freshFileProvider: FreshFileProvider): void {
  log("Refresh command triggered");
  freshFileProvider.hardRefresh();
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

export async function handleToggleHeatmap(freshFileProvider: FreshFileProvider): Promise<void> {
  const config = vscode.workspace.getConfiguration();
  const currentValue = config.get<boolean>("freshFileExplorer.heatmap.enabled", true);
  const newValue = !currentValue;
  
  await config.update("freshFileExplorer.heatmap.enabled", newValue, vscode.ConfigurationTarget.Global);
  
  log(`Heatmap ${newValue ? "enabled" : "disabled"}`);
  
  // Notify the heatmap provider to refresh decorations
  freshFileProvider.heatmapProvider?.fireDidChange();
}
