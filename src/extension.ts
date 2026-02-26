import * as vscode from "vscode";

import { initializeLogger, log } from "./extension/logger";
import { FreshFileItem, FreshFilesTreeItem } from "./treeItems";
import { handleClearFilters, handleFilterByAuthor, handleFilterByCommit } from "./commands/filterCommands";
import {
  handleExpandAll,
  handleExpandSubtree,
  handleOpenFile,
  handleOpenToSide,
  handleRefresh,
  handleRevealInExplorer,
  handleRevealInSourceControl,
  handleSetTimeWindow,
  handleSetGroupingMode,
  handleSetSortOrder,
  handleShowOutput,
  handleToggleOpenMode,
  handleToggleHeatmap,
} from "./commands/basicCommands";
import { handleExhume, handleResurrect } from "./commands/deletedFileCommands";
import { FreshFileProvider } from "./freshFileProvider";
import { setupGitExtensionListener } from "./gitExecutionListener";
import { handleDiscardChanges } from "./commands/discardChangesCommand";
import { handleCreateFileNextTo, handleCreateFileInside } from "./commands/fileCreationCommand";
import { handleOpenChanges } from "./commands/openChangesCommand";
import { handleOpenCommit } from "./commands/openCommitCommand";
import { handleSearchInFreshFiles, handlesearchInFoundFiles, handleOpenAllFoundFiles, handleCopyPathsFromSearchResults } from "./commands/searchCommand";
import { handleQuickPickFile } from "./commands/quickPickCommand";
import { handlePinFile, handleUnpinFile } from "./commands/pinCommands";
import { handleAddNote, handleEditNote, handleDeleteNote, handleToggleNoteCompleted, handleClearAllPinned, handleClearCompleted } from "./commands/noteCommands";
import { handleViewOptions } from "./commands/viewOptionsCommand";
import { Commands } from "./commands/constants";
import { createDragAndDropController } from "./commands/dragDropController";
import { HeatmapDecorationProvider } from "./heatmapDecorationProvider";
import { DiffSearchResultProvider } from "./diffSearchResultProvider";
import { DiffSearchPanel } from "./diffSearchPanel";
import { handleOpenDiffMatch, handleClearDiffSearch, handleGitPickaxe } from "./commands/diffSearchCommand";
import { handleGitLogL, handlegitLogFile } from "./commands/gitLogLCommand";
import { GitLogLContentProvider } from "./gitLogLPanel";
import { ContextManager } from "./extension/contextManager";
import { WorkspaceStateManager } from "./extension/workspaceStateManager";
import { PerfBenchmarkPanel } from "./perfBenchmarkPanel";

export async function activate(context: vscode.ExtensionContext) {
  initializeLogger(context);
  log("Fresh File Explorer extension activating");

  WorkspaceStateManager.initialize(context);

  const freshFileProvider = new FreshFileProvider();
  freshFileProvider.initialize();

  const treeView = createFreshFileTreeView(freshFileProvider, context);
  freshFileProvider.setTreeView(treeView);

  // Create and register heatmap decoration provider
  const heatmapProvider = new HeatmapDecorationProvider(freshFileProvider);
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(heatmapProvider));
  
  // Wire the heatmap provider to the fresh file provider
  freshFileProvider.heatmapProvider = heatmapProvider;

  // Create and register diff search result provider
  const diffSearchResultProvider = new DiffSearchResultProvider();
  const diffSearchTreeView = vscode.window.createTreeView("diffSearchResults", {
    treeDataProvider: diffSearchResultProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(diffSearchTreeView);

  // Set initial context for diff search view visibility
  ContextManager.setDiffSearchHasResults(false);

  // Register virtual document provider for git log -L diff views
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      GitLogLContentProvider.scheme,
      GitLogLContentProvider.instance,
    ),
  );

  registerCommands(context, freshFileProvider, treeView, diffSearchResultProvider);

  // Listen for workspace folder changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      log("Workspace folders changed, re-initializing");
      freshFileProvider.initializeWorkspaceFolders();
      freshFileProvider.hardRefresh();
    }),
  );

  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("freshFileExplorer")) {
        freshFileProvider.onConfigurationChanged();
        
        // If heatmap setting changed, refresh decorations
        if (e.affectsConfiguration("freshFileExplorer.heatmap.enabled")) {
          heatmapProvider.fireDidChange();
        }
      }
    }),
  );

  // Listen for file saves to auto-refresh (updates pending changes)
  // the git listener picks up the change anyway, 
  // but the delay is extremely noticeable (1-2s)
  // this is pretty much instant
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => {
      log("File saved, refreshing pending changes");
      freshFileProvider.refreshPending();
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
  diffSearchResultProvider: DiffSearchResultProvider,
): void {
  function register(name: string, handler: (...args: any[]) => any) {
    context.subscriptions.push(vscode.commands.registerCommand(name, handler));
  }

  register(Commands.REFRESH, () => handleRefresh(freshFileProvider));

  register(Commands.SET_TIME_WINDOW, () => handleSetTimeWindow(freshFileProvider));

  register(Commands.VIEW_OPTIONS, () => handleViewOptions(freshFileProvider));

  register(Commands.SET_GROUPING_MODE, () => handleSetGroupingMode(freshFileProvider));

  register(Commands.SET_SORT_ORDER, () => handleSetSortOrder(freshFileProvider));

  register(Commands.FILTER_BY_AUTHOR, () => handleFilterByAuthor(freshFileProvider));

  register(Commands.FILTER_BY_COMMIT, () => handleFilterByCommit(freshFileProvider));

  register(Commands.CLEAR_FILTERS, () => handleClearFilters(freshFileProvider));

  register(Commands.SEARCH_IN_FRESH_FILES, () => handleSearchInFreshFiles(freshFileProvider));

  register(Commands.SEARCH_IN_FOUND_FILES, () => handlesearchInFoundFiles());

  register(Commands.OPEN_ALL_FOUND_FILES, () => handleOpenAllFoundFiles());

  register(Commands.COPY_PATHS_FROM_SEARCH_RESULTS, () => handleCopyPathsFromSearchResults());

  register(Commands.QUICK_PICK_FILE, () => handleQuickPickFile(freshFileProvider));

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

  register(Commands.CREATE_FILE_NEXT_TO, (item: FreshFileItem, selectedItems?: FreshFileItem[]) =>
    handleCreateFileNextTo(item, selectedItems, freshFileProvider),
  );

  register(Commands.CREATE_FILE_INSIDE, (item: FreshFileItem, selectedItems?: FreshFileItem[]) =>
    handleCreateFileInside(item, selectedItems, freshFileProvider),
  );

  register(Commands.PIN_FILE, (item: FreshFileItem | vscode.Uri, selectedItems?: (FreshFileItem | vscode.Uri)[]) =>
    handlePinFile(item, selectedItems, freshFileProvider),
  );

  register(Commands.UNPIN_FILE, (item: FreshFileItem, selectedItems?: FreshFileItem[]) =>
    handleUnpinFile(item, selectedItems, freshFileProvider),
  );

  register(Commands.ADD_NOTE, () => handleAddNote(freshFileProvider));

  register(Commands.EDIT_NOTE, (item: any) => handleEditNote(item, freshFileProvider));

  register(Commands.TOGGLE_NOTE_COMPLETED, (item: any) => handleToggleNoteCompleted(item, freshFileProvider));

  register(Commands.DELETE_NOTE, (item: any) => handleDeleteNote(item, freshFileProvider));

  register(Commands.CLEAR_ALL_PINNED, () => handleClearAllPinned(freshFileProvider));

  register(Commands.CLEAR_COMPLETED, () => handleClearCompleted(freshFileProvider));

  register(Commands.REVEAL_IN_SOURCE_CONTROL, handleRevealInSourceControl);

  register(Commands.OPEN_COMMIT, (item: FreshFileItem) => handleOpenCommit(item, freshFileProvider));

  register(Commands.TOGGLE_HEATMAP, () => handleToggleHeatmap(freshFileProvider));

  // Diff search commands
  register(Commands.OPEN_DIFF_SEARCH_PANEL, () => 
    DiffSearchPanel.createOrShow(context.extensionUri, diffSearchResultProvider, vscode.workspace.workspaceFolders || [])
  );

  register(Commands.OPEN_DIFF_MATCH, (item: any) => handleOpenDiffMatch(item));

  register(Commands.CLEAR_DIFF_SEARCH, () => handleClearDiffSearch(diffSearchResultProvider));

  register(Commands.GIT_PICKAXE, () =>
    handleGitPickaxe(context.extensionUri, diffSearchResultProvider, vscode.workspace.workspaceFolders || [])
  );

  // Git log -L
  register(Commands.GIT_LOG_L, () => handleGitLogL());
  register(Commands.GIT_LOG_FILE, (item?: any) => handlegitLogFile(item));

  // Performance benchmark
  register(Commands.PERF_BENCHMARK, () =>
    PerfBenchmarkPanel.createOrShow(context.extensionUri, vscode.workspace.workspaceFolders || [])
  );
}

function createFreshFileTreeView(freshFileProvider: FreshFileProvider, context: vscode.ExtensionContext) {
  const treeView = vscode.window.createTreeView("freshFileExplorer", {
    treeDataProvider: freshFileProvider,
    showCollapseAll: true,
    canSelectMany: true,
    dragAndDropController: createDragAndDropController(freshFileProvider),
  });
  context.subscriptions.push(treeView);

  // Set explorer-like context when selection changes so other extensions' commands work
  context.subscriptions.push(
    treeView.onDidChangeSelection(e => {
      const selectedItems = e.selection.filter((item): item is FreshFileItem => item instanceof FreshFileItem);
      if (selectedItems.length > 0) {
        const firstItem = selectedItems[0];
        // Set contexts that other extensions may check
        ContextManager.setSelectedFile(firstItem.resourceUri.fsPath);
        ContextManager.setExplorerResourceIsFolder(firstItem.isDirectory);
      }
    }),
  );
  return treeView;
}
