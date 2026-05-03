import * as vscode from "vscode";

import { initializeLogger, log } from "./extension/logger";
import { FreshFileItem, FreshFilesTreeItem } from "./fresh-files/freshFileTreeItems";
import { handleClearFilters, handleFilterByAuthor, handleFilterByCommit } from "./commands/filterCommands";
import {
  handleDeleteFile,
  handleRenameFile,
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
import { FreshFileProvider } from "./fresh-files/freshFileProvider";
import { setupGitExtensionListener } from "./git/gitExecutionListener";
import { handleDiscardChanges } from "./commands/discardChangesCommand";
import { handleCreateFileNextTo, handleCreateFileInside } from "./commands/fileCreationCommand";
import { handleOpenChanges } from "./commands/openChangesCommand";
import { handleOpenCommit, openCommitByHash } from "./commands/openCommitCommand";
import { handleSearchInFreshFiles, handlesearchInFoundFiles, handleOpenAllFoundFiles, handleCopyPathsFromSearchResults } from "./commands/searchCommand";
import { handleQuickPickFile } from "./commands/quickPickCommand";
import { showBlameHeatmapPicker } from "./commands/heatmapQuickPickCommand";
import { handlePinFile, handleUnpinFile } from "./commands/pinCommands";
import { handleAddNote, handleEditNote, handleDeleteNote, handleToggleNoteCompleted, handleClearAllPinned, handleClearCompleted } from "./commands/noteCommands";
import { handleViewOptions } from "./commands/viewOptionsCommand";
import { handleCopyAbsolutePath, handleCopyRelativePath, handleCopyFilename, handleCopySubtreeStructure } from "./commands/copyPathCommands";
import { handleCopyFile, handleCutFile, handlePasteFile } from "./commands/copyPasteCommands";
import { handleCopyRemoteUrl } from "./commands/copyRemoteUrlCommand";
import { handleCompareSelected, CompareContentProvider } from "./commands/compareFilesCommand";
import { registerCodeTelescopeFinder, openFreshFilesTelescope } from "./code-telescope/codeTelescopeIntegration";
import { handleSetRepoPathspec, handleScopeToFolder, handleClearFolderScope } from "./commands/pathspecCommand";
import { findRepoForAbsolutePath } from "./utils/pathUtils";
import { normalizePath } from "./utils";
import { NormalizedRepoPath } from "./pathTypes";
import { Commands } from "./commands/commandConstants";
import { createFreshFilesDragAndDropController, createPinnedDragAndDropController } from "./commands/dragDropController";
import { HeatmapDecorationProvider } from "./heatmap/heatmapDecorationProvider";
import { BlameHeatmapController } from "./heatmap/blameHeatmapController";
import { FreshFilesStatusBar } from "./fresh-files/freshFilesStatusBar";
import { DiffSearchResultProvider } from "./diff-search/diffSearchResultProvider";
import { DiffSearchPanel } from "./diff-search/diffSearchPanel";
import { handleOpenDiffMatch, handleClearDiffSearch, handleGitPickaxe } from "./commands/diffSearchCommand";
import { handleGitLogL, handlegitLogFile } from "./commands/gitLogLCommand";
import { GitLogLContentProvider } from "./logL/gitLogLPanel";
import { ContextManager } from "./extension/contextManager";
import { WorkspaceStateManager } from "./extension/workspaceStateManager";
import { PerfBenchmarkPanel } from "./benchmark/perfBenchmarkPanel";
import { StonksPanel } from "./stonks/stonksPanel";
import { PinnedItemsProvider } from "./fresh-files/pinnedItemsProvider";
import { ConfigService } from "./config/configService";
import { checkForUpdate } from "./extension/updateNotifier";

export async function activate(context: vscode.ExtensionContext) {
  initializeLogger(context);
  log("Fresh File Explorer activating");
  checkForUpdate(context);

  WorkspaceStateManager.initialize(context);

  let telescopeRegistration: vscode.Disposable | undefined;
  context.subscriptions.push({ dispose: () => telescopeRegistration?.dispose() });

  const freshFileProvider = new FreshFileProvider();
  freshFileProvider.initialize();

  const pinnedItemsProvider = new PinnedItemsProvider(freshFileProvider);
  pinnedItemsProvider.initialize();

  const treeView = createFreshFileTreeView(freshFileProvider, context);
  freshFileProvider.setTreeView(treeView);

  // Create Pinned Items tree view
  const pinnedItemsTreeView = vscode.window.createTreeView("pinnedItems", {
    treeDataProvider: pinnedItemsProvider,
    showCollapseAll: false,
    canSelectMany: true,
    dragAndDropController: createPinnedDragAndDropController(pinnedItemsProvider),
  });
  context.subscriptions.push(pinnedItemsTreeView);

  // Create and register heatmap decoration provider
  const heatmapProvider = new HeatmapDecorationProvider(freshFileProvider);
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(heatmapProvider));
  
  // Wire the heatmap provider to the fresh file provider
  freshFileProvider.heatmapProvider = heatmapProvider;

  // Create blame heatmap controller (per-line editor decorations)
  const blameHeatmapController = new BlameHeatmapController(freshFileProvider);
  context.subscriptions.push(blameHeatmapController);

  // Steady status-bar indicator for Fresh Files loading progress.
  context.subscriptions.push(new FreshFilesStatusBar(freshFileProvider));

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

  // Register virtual document provider for multi-file compare
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      CompareContentProvider.scheme,
      new CompareContentProvider(),
    ),
  );

  registerCommands(context, freshFileProvider, pinnedItemsProvider, treeView, pinnedItemsTreeView, diffSearchResultProvider, blameHeatmapController);
  telescopeRegistration = await registerCodeTelescopeFinder(freshFileProvider);

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
    vscode.workspace.onDidChangeConfiguration(async e => {
      if (e.affectsConfiguration("freshFileExplorer")) {
        freshFileProvider.onConfigurationChanged(e);
        
        // If heatmap setting changed, refresh decorations
        if (e.affectsConfiguration("freshFileExplorer.heatmap.enabled")) {
          heatmapProvider.fireDidChange();
        }

        if (e.affectsConfiguration("freshFileExplorer.codeTelescopeIntegration")) {
          telescopeRegistration?.dispose();
          telescopeRegistration = await registerCodeTelescopeFinder(freshFileProvider);
        }
      }
    }),
  );

  // Listen for file saves to auto-refresh (updates pending changes)
  // the git listener picks up the change anyway, 
  // but the delay is extremely noticeable (1-2s)
  // this is pretty much instant
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      log("File saved, refreshing pending changes");
      const result = findRepoForAbsolutePath(freshFileProvider.workspaceFolders, document.uri.fsPath);
      freshFileProvider.refreshPending(result ? [normalizePath(result.repoFullPath) as NormalizedRepoPath] : undefined);
    }),
  );


  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      if (ConfigService.getAutoReveal()) {
        freshFileProvider.revealActiveFile(false);
      }
    }),
  );

  // Listen for git state changes (commits, checkouts, etc.)
  // The git extension exposes an API we can use
  setupGitExtensionListener(context, freshFileProvider, api => blameHeatmapController.connectGitApi(api));

  log("Fresh File Explorer activated");
}

export function deactivate() {
  log("Fresh File Explorer deactivating");
}

function registerCommands(
  context: vscode.ExtensionContext,
  freshFileProvider: FreshFileProvider,
  pinnedItemsProvider: PinnedItemsProvider,
  treeView: vscode.TreeView<FreshFilesTreeItem>,
  pinnedItemsTreeView: vscode.TreeView<FreshFilesTreeItem>,
  diffSearchResultProvider: DiffSearchResultProvider,
  blameHeatmapController: BlameHeatmapController,
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

  register(Commands.CLEAR_FILTERS, () => handleClearFilters(freshFileProvider.filterManager));

  register(Commands.SEARCH_IN_FRESH_FILES, () => handleSearchInFreshFiles(freshFileProvider));

  register(Commands.SEARCH_IN_FOUND_FILES, () => handlesearchInFoundFiles());

  register(Commands.OPEN_ALL_FOUND_FILES, () => handleOpenAllFoundFiles());

  register(Commands.COPY_PATHS_FROM_SEARCH_RESULTS, () => handleCopyPathsFromSearchResults());

  register(Commands.QUICK_PICK_FILE, async () => {
    const handledWithTelescope = await openFreshFilesTelescope();
    if (!handledWithTelescope) {
      // either the integration is not installed or it failed - fall back to our quick pick
      await handleQuickPickFile(freshFileProvider);
    }
  });

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

  register(Commands.FOCUS_SUBMODULE_REPO, (fsPath: string) => freshFileProvider.revealSubmoduleRepo(fsPath));

  register(Commands.REVEAL_ACTIVE_FILE, () => freshFileProvider.revealActiveFile(true));

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

  register(Commands.DELETE_FILE, (item: FreshFileItem, selectedItems?: FreshFileItem[]) =>
    handleDeleteFile(item, selectedItems, freshFileProvider, treeView),
  );

  register(Commands.RENAME_FILE, (item: FreshFileItem, selectedItems?: FreshFileItem[]) =>
    handleRenameFile(item, selectedItems, freshFileProvider, treeView),
  );

  register(Commands.CREATE_FILE_NEXT_TO, (item: FreshFileItem, selectedItems?: FreshFileItem[]) =>
    handleCreateFileNextTo(item, selectedItems, freshFileProvider),
  );

  register(Commands.CREATE_FILE_INSIDE, (item: FreshFileItem, selectedItems?: FreshFileItem[]) =>
    handleCreateFileInside(item, selectedItems, freshFileProvider),
  );

  register(Commands.PIN_FILE, (item: FreshFileItem | vscode.Uri, selectedItems?: (FreshFileItem | vscode.Uri)[]) =>
    handlePinFile(item, selectedItems, pinnedItemsProvider),
  );

  register(Commands.UNPIN_FILE, (item: FreshFileItem, selectedItems?: FreshFileItem[]) =>
    handleUnpinFile(item, selectedItems, pinnedItemsProvider),
  );

  register(Commands.ADD_NOTE, () => handleAddNote(pinnedItemsProvider));

  register(Commands.EDIT_NOTE, (item: any) => handleEditNote(item, pinnedItemsProvider));

  register(Commands.TOGGLE_NOTE_COMPLETED, (item: any) => handleToggleNoteCompleted(item, pinnedItemsProvider));

  register(Commands.DELETE_NOTE, (item: any) => handleDeleteNote(item, pinnedItemsProvider));

  register(Commands.CLEAR_ALL_PINNED, () => handleClearAllPinned(pinnedItemsProvider));

  register(Commands.CLEAR_COMPLETED, () => handleClearCompleted(pinnedItemsProvider));

  register(Commands.REVEAL_IN_SOURCE_CONTROL, handleRevealInSourceControl);

  register(Commands.OPEN_COMMIT, (item: FreshFileItem) => handleOpenCommit(item, freshFileProvider));
  register(Commands.OPEN_COMMIT_FROM_BLAME, (commitHash: string, repoRoot: string) => openCommitByHash(commitHash, repoRoot));

  // Gutter right-click menu paths — receive `{ lineNumber, uri }` from the
  // editor/lineNumber/context menu (line numbers are 1-based).
  register(Commands.RESTORE_DELETED_LINES_AT, (arg: { lineNumber: number; uri: vscode.Uri }) => {
    if (!arg) { return; }
    return blameHeatmapController.restoreDeletionAt(arg.uri, arg.lineNumber);
  });
  register(Commands.COPY_DELETED_LINES_AT, (arg: { lineNumber: number; uri: vscode.Uri }) => {
    if (!arg) { return; }
    return blameHeatmapController.copyDeletionAt(arg.uri, arg.lineNumber);
  });

  register(Commands.TOGGLE_HEATMAP, () => handleToggleHeatmap(freshFileProvider));

  register(Commands.BLAME_HEATMAP_PICKER, () => showBlameHeatmapPicker(blameHeatmapController));

  // Two command IDs share a handler — they exist only to give the editor's
  // right-click menu two different titles depending on whether a baseline ref
  // is already saved. Visibility is gated by the freshFiles.blameHeatmap.hasBaseRef
  // context key set by the controller.
  const baselineDiffHandler = () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) { blameHeatmapController.openBaselineDiff(editor); }
  };
  register(Commands.BLAME_DIFF_BASELINE, baselineDiffHandler);
  register(Commands.BLAME_DIFF_BASELINE_CONFIGURED, baselineDiffHandler);

  // Direct heatmap actions used by the gutter submenu — bypass the picker.
  // Each acts on the active editor and reuses controller methods.
  const onActiveEditor = (fn: (editor: vscode.TextEditor) => void | Promise<void>) => () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) { return fn(editor); }
  };
  register(Commands.BLAME_APPLY_AGE, onActiveEditor(e => blameHeatmapController.applyMode(e, "absolute")));
  register(Commands.BLAME_APPLY_BRANCH_SAVED, onActiveEditor(e => blameHeatmapController.applyMode(e, "branch")));
  register(Commands.BLAME_PICK_BRANCH, onActiveEditor(e => blameHeatmapController.selectBranchMode(e)));
  register(Commands.BLAME_TURN_OFF, onActiveEditor(e => blameHeatmapController.turnOff(e)));
  register(Commands.BLAME_CLEAR_BASELINE, onActiveEditor(e => blameHeatmapController.clearSavedBaseRef(e)));
  register(Commands.BLAME_TOGGLE_AUTO_APPLY, () =>
    ConfigService.setBlameHeatmapAutoApply(!ConfigService.getBlameHeatmapAutoApply()),
  );

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
  register(Commands.GIT_LOG_FILE, handlegitLogFile);

  // Performance benchmark
  register(Commands.PERF_BENCHMARK, () =>
    PerfBenchmarkPanel.createOrShow(
      context.extensionUri,
      vscode.workspace.workspaceFolders || [],
      () => freshFileProvider.getCacheStats(),
    )
  );

  // Stonks panel
  register(Commands.OPEN_STONKS_PANEL, () =>
    StonksPanel.createOrShow(context.extensionUri, freshFileProvider)
  );

  // File copy/cut/paste
  register(Commands.COPY_FILE, (item: FreshFileItem, selectedItems?: FreshFileItem[]) =>
    handleCopyFile(item, selectedItems, treeView),
  );

  register(Commands.CUT_FILE, (item: FreshFileItem, selectedItems?: FreshFileItem[]) =>
    handleCutFile(item, selectedItems, treeView),
  );

  register(Commands.PASTE_FILE, (item: FreshFileItem, selectedItems?: FreshFileItem[]) =>
    handlePasteFile(item, selectedItems, freshFileProvider, treeView),
  );

  // Copy path commands
  register(Commands.COPY_ABSOLUTE_PATH, (item: FreshFileItem, selectedItems?: FreshFileItem[]) =>
    handleCopyAbsolutePath(item, selectedItems),
  );

  register(Commands.COPY_RELATIVE_PATH, (item: FreshFileItem, selectedItems?: FreshFileItem[]) =>
    handleCopyRelativePath(item, selectedItems),
  );

  register(Commands.COPY_FILENAME, (item: FreshFileItem, selectedItems?: FreshFileItem[]) =>
    handleCopyFilename(item, selectedItems),
  );

  register(Commands.COPY_SUBTREE_STRUCTURE, (arg: FreshFileItem | vscode.Uri) =>
    handleCopySubtreeStructure(arg, freshFileProvider),
  );

  register(Commands.COPY_REMOTE_URL, (arg: FreshFileItem | vscode.Uri | undefined, rest?: FreshFileItem[] | vscode.Uri[]) =>
    handleCopyRemoteUrl(arg, rest, freshFileProvider),
  );

  register(Commands.SET_REPO_PATHSPEC, (item: FreshFileItem) =>
    handleSetRepoPathspec(item, freshFileProvider),
  );

  register(Commands.SCOPE_TO_FOLDER, (item: FreshFileItem) =>
    handleScopeToFolder(item, freshFileProvider, treeView),
  );

  register(Commands.CLEAR_FOLDER_SCOPE, (item: FreshFileItem) =>
    handleClearFolderScope(item, freshFileProvider),
  );

  register(Commands.COMPARE_SELECTED, (item: FreshFileItem, selectedItems?: FreshFileItem[]) =>
    handleCompareSelected(item, selectedItems, [treeView, pinnedItemsTreeView]),
  );
}

function createFreshFileTreeView(freshFileProvider: FreshFileProvider, context: vscode.ExtensionContext) {
  const treeView = vscode.window.createTreeView("freshFileExplorer", {
    treeDataProvider: freshFileProvider,
    showCollapseAll: true,
    canSelectMany: true,
    dragAndDropController: createFreshFilesDragAndDropController(freshFileProvider),
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
