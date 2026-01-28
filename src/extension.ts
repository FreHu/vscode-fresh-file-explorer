import * as vscode from "vscode";

import { initializeLogger, log } from "./utils/logger";
import { FreshFileItem, FreshFilesTreeItem } from "./treeItems";
import { handleClearFilters, handleFilterByAuthor, handleFilterByCommit } from "./commands/filterCommands";
import {
  handleExpandAll,
  handleExpandSubtree,
  handleInitializeRepo,
  handleOpenFile,
  handleOpenToSide,
  handleRefresh,
  handleRevealInExplorer,
  handleRevealInSourceControl,
  handleSetTimeWindow,
  handleShowOutput,
  handleToggleOpenMode,
} from "./commands/basicCommands";
import { handleExhume, handleResurrect } from "./commands/deletedFileCommands";
import { FreshFileProvider } from "./freshFileProvider";
import { setupGitExtensionListener } from "./gitExecutionListener";
import { handleDiscardChanges } from "./commands/discardChangesCommand";
import { handleOpenChanges } from "./commands/openChangesCommand";
import { registerSearchInFreshFilesCommand } from "./commands/searchCommand";
import { Commands } from "./commands/constants";

export async function activate(context: vscode.ExtensionContext) {
  initializeLogger(context);
  log("Fresh File Explorer extension activating");

  const freshFileProvider = new FreshFileProvider();
  freshFileProvider.initialize(context);

  const treeView = createFreshFileTreeView(freshFileProvider, context);

  registerCommands(context, freshFileProvider, treeView);

  // Listen for workspace folder changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      log("Workspace folders changed, re-initializing");
      freshFileProvider.initializeWorkspaceFolders();
      freshFileProvider.refresh();
    }),
  );

  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("freshFileExplorer")) {
        freshFileProvider.onConfigurationChanged();
      }
    }),
  );

  // Listen for file saves to auto-refresh (updates pending changes)
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => {
      log("File saved, refreshing pending changes");
      freshFileProvider.refresh();
    }),
  );

  // Listen for git state changes (commits, checkouts, etc.)
  // The git extension exposes an API we can use
  setupGitExtensionListener(context, freshFileProvider);

  log("Fresh File Explorer extension activated successfully");
}

export function deactivate() {
  log("Fresh File Explorer extension deactivating");
}

function registerCommands(
  context: vscode.ExtensionContext,
  freshFileProvider: FreshFileProvider,
  treeView: vscode.TreeView<FreshFilesTreeItem>,
): void {
  function register(name: string, handler: (...args: any[]) => any) {
    context.subscriptions.push(vscode.commands.registerCommand(name, handler));
  }

  register(Commands.REFRESH, () => handleRefresh(freshFileProvider));

  register(Commands.INITIALIZE_REPO, () => handleInitializeRepo(freshFileProvider));

  register(Commands.SET_TIME_WINDOW, () => handleSetTimeWindow(freshFileProvider));

  register(Commands.FILTER_BY_AUTHOR, () => handleFilterByAuthor(freshFileProvider));

  register(Commands.FILTER_BY_COMMIT, () => handleFilterByCommit(freshFileProvider));

  register(Commands.CLEAR_FILTERS, () => handleClearFilters(freshFileProvider));

  registerSearchInFreshFilesCommand(context, freshFileProvider);

  register(Commands.EXHUME, (item: FreshFileItem) => handleExhume(item, freshFileProvider));

  register(Commands.RESURRECT, (item: FreshFileItem, selectedItems?: FreshFileItem[]) =>
    handleResurrect(item, selectedItems, freshFileProvider),
  );

  register(Commands.SHOW_OUTPUT, handleShowOutput);

  register(Commands.EXPAND_ALL, () => handleExpandAll(freshFileProvider, treeView));

  register(Commands.EXPAND_SUBTREE, (item: FreshFileItem) => handleExpandSubtree(item, treeView, freshFileProvider));

  register(Commands.REVEAL_IN_EXPLORER, handleRevealInExplorer);

  register(
    Commands.OPEN_FILE,
    (item: FreshFileItem, selectedItems?: FreshFileItem[], options?: { preserveFocus?: boolean }) =>
      handleOpenFile(item, selectedItems, options),
  );

  register(
    Commands.OPEN_CHANGES,
    (item: FreshFileItem, selectedItems?: FreshFileItem[], options?: { preserveFocus?: boolean }) =>
      handleOpenChanges(item, selectedItems, options),
  );

  register(Commands.TOGGLE_OPEN_MODE, () => handleToggleOpenMode(freshFileProvider));

  register(Commands.OPEN_TO_SIDE, (item: FreshFileItem, selectedItems?: FreshFileItem[]) =>
    handleOpenToSide(item, selectedItems),
  );

  register(Commands.DISCARD_CHANGES, (item: FreshFileItem, selectedItems?: FreshFileItem[]) =>
    handleDiscardChanges(item, selectedItems, freshFileProvider),
  );

  register(Commands.REVEAL_IN_SOURCE_CONTROL, handleRevealInSourceControl);
}

function createFreshFileTreeView(freshFileProvider: FreshFileProvider, context: vscode.ExtensionContext) {
  const treeView = vscode.window.createTreeView("freshFileExplorer", {
    treeDataProvider: freshFileProvider,
    showCollapseAll: true,
    canSelectMany: true,
    dragAndDropController: {
      dragMimeTypes: ["text/uri-list"],
      dropMimeTypes: [],
      handleDrag: (items: readonly FreshFilesTreeItem[], dataTransfer: vscode.DataTransfer) => {
        // Only handle FreshFileItem, not MessageItem, and exclude deleted files and directories
        const uris = items
          .filter((item): item is FreshFileItem => item instanceof FreshFileItem && !item.isDeleted && !item.isDirectory)
          .map(item => item.resourceUri);
        if (uris.length > 0) {
          // Use CRLF (\r\n) as separator per text/uri-list spec (RFC 2483)
          dataTransfer.set("text/uri-list", new vscode.DataTransferItem(uris.map(uri => uri.toString()).join("\r\n")));
        }
      },
      handleDrop: undefined,
    },
  });
  context.subscriptions.push(treeView);

  // Set explorer-like context when selection changes so other extensions' commands work
  context.subscriptions.push(
    treeView.onDidChangeSelection(e => {
      const selectedItems = e.selection.filter((item): item is FreshFileItem => item instanceof FreshFileItem);
      if (selectedItems.length > 0) {
        const firstItem = selectedItems[0];
        // Set contexts that other extensions may check
        vscode.commands.executeCommand("setContext", "freshFileExplorer.selectedFile", firstItem.resourceUri.fsPath);
        vscode.commands.executeCommand("setContext", "explorerResourceIsFolder", firstItem.isDirectory);
      }
    }),
  );
  return treeView;
}
