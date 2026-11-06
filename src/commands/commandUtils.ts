import * as vscode from "vscode";
import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { findRepoPathsForFiles } from "../utils/pathUtils";

// Lives in a vscode-free module so its precedence rules are unit-testable;
// re-exported here so existing importers keep their import path.
export { resolveCommandSelection } from "./commandSelection";

/**
 * Refresh only the repos that the given files belong to (working-tree refresh).
 * Falls back to a full pending refresh when no file maps to a known repo.
 * Returns the underlying promise so callers can `await` or `void` it.
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

/**
 * Show a single-select picker and resolve with the accepted item, or
 * undefined when it was dismissed.
 */
export async function pickOne<T extends vscode.QuickPickItem>(quickPick: vscode.QuickPick<T>): Promise<T | undefined> {
  let picked: T | undefined;
  const accepted = await runQuickPickPromise(quickPick, (qp) => { picked = qp.selectedItems[0]; });
  return accepted ? picked : undefined;
}

/**
 * Picker over a setting's options with the current one checked. `onSelect`
 * runs only when the accepted option differs from `getCurrent()`.
 * Resolves like {@link runQuickPickPromise}.
 */
export function pickCurrentOption<T>(opts: {
  title: string;
  placeholder: string;
  options: { label: string; description?: string; value: T }[];
  getCurrent: () => T;
  onSelect: (value: T) => void;
}): Promise<boolean> {
  const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { value: T }>();
  quickPick.title = opts.title;
  quickPick.placeholder = opts.placeholder;
  const current = opts.getCurrent();
  quickPick.items = opts.options.map(option => ({ ...option, picked: option.value === current }));
  return runQuickPickPromise(quickPick, (qp) => {
    const selected = qp.selectedItems[0];
    if (selected && selected.value !== opts.getCurrent()) {
      opts.onSelect(selected.value);
    }
  });
}
