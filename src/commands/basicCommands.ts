import * as vscode from "vscode";
import * as path from "path";

import { FreshFileItem, FreshFilesTreeItem } from "../fresh-files/freshFileTreeItems";
import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { BranchCompareProvider } from "../branch-compare/branchCompareProvider";
import { log, showOutputChannel } from "../extension/logger";
import { expandItemRecursively } from "../utils/treeUtils";
import { createTimeWindowQuickPick } from "../utils/quickPick";
import { GROUPING_MODE_OPTIONS, GroupingMode } from "../fresh-files/groupingMode";
import { SortOrder } from "../types";
import { findRepoForAbsolutePath } from "../utils/pathUtils";
import { refreshPendingForFiles, resolveCommandSelection, runQuickPickPromise } from "./commandUtils";
import { execGitWithArgs } from "../git/gitOperations";
import { ConfigService } from "../config/configService";
import { normalizePath } from "../utils";

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

  return runQuickPickPromise(quickPick, (qp) => {
    const selected = qp.selectedItems[0] as any;
    if (selected && selected.mode !== freshFileProvider.groupingMode) {
      freshFileProvider.setGroupingMode(selected.mode as GroupingMode);
    }
  });
}

export async function handleSetSortOrder(freshFileProvider: FreshFileProvider, branchCompareProvider?: BranchCompareProvider): Promise<boolean> {
  log("Set sort order command triggered");

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

  return runQuickPickPromise(quickPick, (qp) => {
    const selected = qp.selectedItems[0] as any;
    if (selected && selected.order !== freshFileProvider.sortOrder) {
      freshFileProvider.setSortOrder(selected.order as SortOrder);
      branchCompareProvider?.rerenderForSortChange();
    }
  });
}

export function handleShowOutput(): void {
  showOutputChannel();
}

/** Open VS Code's Settings UI filtered to this extension's section. */
export function handleOpenSettings(): void {
  void vscode.commands.executeCommand("workbench.action.openSettings", "@ext:frehu.fresh-file-explorer");
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

// Only needs a resourceUri, so it stays type-agnostic about the tree item —
// works across fresh files, pinned items, and branch compare (whose items are
// not FreshFileItem but do expose resourceUri).
export function handleRevealFileInOS(
  item: vscode.TreeItem | undefined,
  selectedItems?: vscode.TreeItem[],
  treeViews?: ReadonlyArray<Pick<vscode.TreeView<vscode.TreeItem>, "selection">>,
): void {
  // Keybinding path: item and selectedItems are undefined — fall back to the
  // focused tree view's current selection.
  let target = item || selectedItems?.[0];
  if (!target) {
    for (const tv of treeViews ?? []) {
      const sel = tv.selection.filter((i) => !!i.resourceUri);
      if (sel.length > 0) {
        target = sel[0];
        break;
      }
    }
  }
  if (target?.resourceUri) {
    log(`Revealing in OS file explorer: ${target.resourceUri.fsPath}`);
    vscode.commands.executeCommand("revealFileInOS", target.resourceUri);
  }
}

export async function handleOpenFile(
  item: FreshFileItem,
  selectedItems?: FreshFileItem[],
  options?: { preserveFocus?: boolean },
): Promise<void> {
  const items = resolveCommandSelection(item, selectedItems);
  const preserveFocus = options?.preserveFocus ?? false;
  for (const fileItem of items.filter(isPossibleToOpen)) {
    await vscode.commands.executeCommand("vscode.open", fileItem.resourceUri, {
      preserveFocus,
      preview: preserveFocus,
    });
  }
}

/**
 * Set the Fresh Files left-click open mode: `true` opens diffs, `false` opens
 * files. The two view-title buttons each call this with a fixed value (only the
 * button for the *other* mode is visible), so the icon alternates by state.
 */
export function handleSetOpenMode(freshFileProvider: FreshFileProvider, value: boolean): void {
  freshFileProvider.setOpenMode(value);
}

export async function handleOpenToSide(item: FreshFileItem, selectedItems?: FreshFileItem[]): Promise<void> {
  const items = resolveCommandSelection(item, selectedItems);
  for (const fileItem of items.filter(isPossibleToOpen)) {
    await vscode.commands.executeCommand("vscode.open", fileItem.resourceUri, vscode.ViewColumn.Beside);
  }
}

export function isPossibleToOpen(item: FreshFileItem) {
  return item && item.resourceUri && !item.isDirectory;
}

export function handleRevealInSourceControl(
  arg?: FreshFileItem | vscode.Uri,
  selectedItems?: FreshFileItem[],
): void {
  const targetUri = arg instanceof vscode.Uri
    ? arg
    : (arg ?? selectedItems?.[0])?.resourceUri;
  if (!targetUri) {
    return;
  }
  log(`Revealing in source control: ${targetUri.fsPath}`);
  vscode.commands.executeCommand("workbench.view.scm");
  vscode.commands.executeCommand("git.openFile", targetUri);
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
  const allItems = resolveCommandSelection(item, selectedItems, treeSelection);
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
    void refreshPendingForFiles(freshFileProvider, targets.map(i => i.resourceUri.fsPath));
  }
}

export async function handleRenameFile(
  item: FreshFileItem,
  _selectedItems: FreshFileItem[] | undefined,
  freshFileProvider: FreshFileProvider,
  treeView?: vscode.TreeView<FreshFilesTreeItem>,
): Promise<void> {
  // Keybinding case: item is undefined, fall back to tree selection
  const treeSelection = treeView?.selection.filter((i): i is FreshFileItem => i instanceof FreshFileItem);
  const target = item ?? treeSelection?.[0];

  if (!target?.resourceUri || target.isDeleted) {
    return;
  }

  const oldPath = target.resourceUri.fsPath;
  const oldName = path.basename(oldPath);
  const parentDir = path.dirname(oldPath);

  // Pre-select name without extension for files, full name for folders
  const dotIndex = oldName.lastIndexOf(".");
  const selectionEnd = !target.isDirectory && dotIndex > 0 ? dotIndex : oldName.length;

  const newName = await vscode.window.showInputBox({
    prompt: "Enter new name",
    value: oldName,
    valueSelection: [0, selectionEnd],
    validateInput: (value) => {
      if (!value || value.trim().length === 0) {
        return "Name cannot be empty";
      }
      if (value.includes("/") || value.includes("\\")) {
        return "Name cannot contain path separators";
      }
      if (value === oldName) {
        return "Name is unchanged";
      }
      return undefined;
    },
  });

  if (!newName) {
    return;
  }

  const newPath = path.join(parentDir, newName);

  try {
    const repoResult = findRepoForAbsolutePath(freshFileProvider.workspaceFolders, oldPath);

    if (ConfigService.getAutoStageRename() && repoResult) {
      // git mv: paths relative to repo root
      const repoRoot = repoResult.repoFullPath;
      const oldRelative = normalizePath(oldPath).substring(normalizePath(repoRoot).length + 1);
      const newRelative = normalizePath(newPath).substring(normalizePath(repoRoot).length + 1);
      await execGitWithArgs(["mv", oldRelative, newRelative], repoRoot);
    } else {
      // Plain filesystem rename
      const oldUri = vscode.Uri.file(oldPath);
      const newUri = vscode.Uri.file(newPath);
      await vscode.workspace.fs.rename(oldUri, newUri, { overwrite: false });
    }

    log(`Renamed: ${oldName} → ${newName}`);
    void refreshPendingForFiles(freshFileProvider, [oldPath, newPath]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Rename failed: ${message}`, "error");
    vscode.window.showErrorMessage(`Failed to rename: ${message}`);
  }
}

export async function handleToggleHeatmap(freshFileProvider: FreshFileProvider): Promise<void> {
  const newValue = !ConfigService.isHeatmapEnabled();

  await ConfigService.setHeatmapEnabled(newValue);

  log(`Heatmap ${newValue ? "enabled" : "disabled"}`);
  
  // Notify the heatmap provider to refresh decorations
  freshFileProvider.heatmapProvider?.fireDidChange();
}
