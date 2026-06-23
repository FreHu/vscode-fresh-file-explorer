import * as vscode from "vscode";
import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { findRepoPathsForFiles } from "../utils/pathUtils";

/**
 * Resolve which tree items a command should act on, in priority order:
 *   1. an explicit multi-selection (`selectedItems`, when non-empty),
 *   2. the single right-clicked `item`,
 *   3. the tree view's current selection (the keybinding path, where VS Code
 *      passes neither `item` nor `selectedItems` — callers pass an already
 *      type-filtered `treeSelection`).
 *
 * Replaces the `selectedItems?.length ? selectedItems : item ? [item] : []`
 * ternary that was copy-pasted across the command handlers.
 */
export function resolveCommandSelection<T extends vscode.TreeItem>(
  item: T | undefined,
  selectedItems: T[] | undefined,
  treeSelection?: readonly T[],
): T[] {
  if (selectedItems && selectedItems.length > 0) { return selectedItems; }
  if (item) { return [item]; }
  if (treeSelection && treeSelection.length > 0) { return [...treeSelection]; }
  return [];
}

/**
 * Refresh only the repos that the given files belong to (working-tree refresh).
 * Falls back to a full pending refresh when no file maps to a known repo.
 *
 * Replaces the `findRepoPathsForFiles(...) + refreshPending(paths.length ? ...)`
 * pair duplicated after every file-mutating command. Returns the underlying
 * promise so callers can `await` or `void` it as they already do.
 */
export function refreshPendingForFiles(
  provider: FreshFileProvider,
  absoluteFilePaths: string[],
): Promise<void> {
  const repoPaths = findRepoPathsForFiles(provider.workspaceFolders, absoluteFilePaths);
  return provider.refreshPending(repoPaths.length > 0 ? repoPaths : undefined);
}

/**
 * Show a QuickPick and resolve to whether the user accepted a selection
 * (`true`) or dismissed it (`false`). `onAccept` runs the side effect for the
 * accepted selection before the picker hides. Guards against the double-settle
 * that happens because accepting also fires `onDidHide`, and disposes the
 * picker on hide.
 */
export function runQuickPickPromise<T extends vscode.QuickPickItem>(
  quickPick: vscode.QuickPick<T>,
  onAccept: (quickPick: vscode.QuickPick<T>) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const settle = (value: boolean) => {
      if (!resolved) { resolved = true; resolve(value); }
    };
    quickPick.onDidAccept(() => {
      onAccept(quickPick);
      quickPick.hide();
      settle(true);
    });
    quickPick.onDidHide(() => {
      settle(false);
      quickPick.dispose();
    });
    quickPick.show();
  });
}
