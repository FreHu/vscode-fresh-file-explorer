/**
 * Command IDs used throughout the Fresh File Explorer extension
 */
export const Commands = {
  // Main commands
  REFRESH: "freshFileExplorer.refresh",
  SET_TIME_WINDOW: "freshFileExplorer.setTimeWindow",
  VIEW_OPTIONS: "freshFileExplorer.viewOptions",
  SET_GROUPING_MODE: "freshFileExplorer.setGroupingMode",
  SET_SORT_ORDER: "freshFileExplorer.setSortOrder",
  SHOW_OUTPUT: "freshFileExplorer.showOutput",
  EXPAND_ALL: "freshFileExplorer.expandAll",
  EXPAND_SUBTREE: "freshFileExplorer.expandSubtree",

  // Filter commands
  FILTER_BY_AUTHOR: "freshFileExplorer.filterByAuthor",
  FILTER_BY_COMMIT: "freshFileExplorer.filterByCommit",
  CLEAR_FILTERS: "freshFileExplorer.clearFilters",

  // Search commands
  SEARCH_IN_FRESH_FILES: "freshFileExplorer.searchInFreshFiles",
  SEARCH_IN_FOUND_FILES: "freshFileExplorer.searchInFoundFiles",
  OPEN_ALL_FOUND_FILES: "freshFileExplorer.openAllFoundFiles",
  COPY_PATHS_FROM_SEARCH_RESULTS: "freshFileExplorer.copyPathsFromSearchResults",

  // Quick pick command
  QUICK_PICK_FILE: "freshFileExplorer.quickPickFile",

  // Deleted file commands
  EXHUME: "freshFileExplorer.exhume",
  RESURRECT: "freshFileExplorer.resurrect",

  // File operation commands
  REVEAL_IN_EXPLORER: "freshFileExplorer.revealInExplorer",
  REVEAL_FILE_IN_OS: "freshFileExplorer.revealFileInOS",
  OPEN_FILE: "freshFileExplorer.openFile",
  OPEN_CHANGES: "freshFileExplorer.openChanges",
  OPEN_TO_SIDE: "freshFileExplorer.openToSide",
  DISCARD_CHANGES: "freshFileExplorer.discardChanges",
  DELETE_FILE: "freshFileExplorer.deleteFile",
  REVEAL_IN_SOURCE_CONTROL: "freshFileExplorer.revealInSourceControl",
  OPEN_MODE_CHANGES: "freshFileExplorer.openMode.changes",
  OPEN_MODE_FILE: "freshFileExplorer.openMode.file",
  CREATE_FILE_NEXT_TO: "freshFileExplorer.createFileNextTo",
  CREATE_FILE_INSIDE: "freshFileExplorer.createFileInside",

  // Pin commands
  PIN_FILE: "freshFileExplorer.pinFile",
  UNPIN_FILE: "freshFileExplorer.unpinFile",
  ADD_NOTE: "freshFileExplorer.addNote",
  EDIT_NOTE: "freshFileExplorer.editNote",
  TOGGLE_NOTE_COMPLETED: "freshFileExplorer.toggleNoteCompleted",
  DELETE_NOTE: "freshFileExplorer.deleteNote",
  CLEAR_ALL_PINNED: "freshFileExplorer.clearAllPinned",
  CLEAR_COMPLETED: "freshFileExplorer.clearCompleted",

  // Commit viewing
  OPEN_COMMIT: "freshFileExplorer.openCommit",
  OPEN_COMMIT_FROM_BLAME: "freshFileExplorer.openCommitFromBlame",

  // Heatmap commands
  TOGGLE_HEATMAP: "freshFileExplorer.toggleHeatmap",
  BLAME_HEATMAP_PICKER: "freshFileExplorer.blameHeatmapPicker",
  BLAME_DIFF_BASELINE: "freshFileExplorer.blameDiffBaseline",
  BLAME_DIFF_BASELINE_CONFIGURED: "freshFileExplorer.blameDiffBaselineConfigured",
  RESTORE_DELETED_LINES_AT: "freshFileExplorer.restoreDeletedLinesAt",
  COPY_DELETED_LINES_AT: "freshFileExplorer.copyDeletedLinesAt",
  // Direct heatmap actions (gutter submenu — bypass picker)
  BLAME_APPLY_AGE: "freshFileExplorer.blameApplyAge",
  BLAME_APPLY_BRANCH_SAVED: "freshFileExplorer.blameApplyBranchSaved",
  BLAME_PICK_BRANCH: "freshFileExplorer.blamePickBranch",
  BLAME_TURN_OFF: "freshFileExplorer.blameTurnOff",
  BLAME_CLEAR_BASELINE: "freshFileExplorer.blameClearBaseline",
  BLAME_TOGGLE_AUTO_APPLY: "freshFileExplorer.blameToggleAutoApply",

  // Diff search commands
  OPEN_DIFF_SEARCH_PANEL: "freshFileExplorer.openDiffSearchPanel",
  OPEN_DIFF_MATCH: "freshFileExplorer.openDiffMatch",
  CLEAR_DIFF_SEARCH: "freshFileExplorer.clearDiffSearch",
  // Results-side change-type filter — cycles all → added → removed → all (no git re-run).
  // Each command is shown only in its matching state, so the toolbar icon reflects the
  // current filter and clicking it advances to the next.
  DIFF_SEARCH_SHOWING_ALL: "freshFileExplorer.diffSearch.showingAll",
  DIFF_SEARCH_SHOWING_ADDED: "freshFileExplorer.diffSearch.showingAdded",
  DIFF_SEARCH_SHOWING_REMOVED: "freshFileExplorer.diffSearch.showingRemoved",

  // Git log -L (line / function history)
  GIT_LOG_L: "freshFileExplorer.gitLogL",

  // Git log for entire file history
  GIT_LOG_FILE: "freshFileExplorer.gitLogFile",

  // Git pickaxe search (-S): open diff search panel prefilled with selection
  GIT_PICKAXE: "freshFileExplorer.gitPickaxe",

  // Performance benchmark panel
  PERF_BENCHMARK: "freshFileExplorer.perfBenchmark",

  // Stonks panel (file count chart)
  OPEN_STONKS_PANEL: "freshFileExplorer.openStonksPanel",

  // File copy/cut/paste
  COPY_FILE: "freshFileExplorer.copyFile",
  CUT_FILE: "freshFileExplorer.cutFile",
  PASTE_FILE: "freshFileExplorer.pasteFile",

  // Copy path commands
  COPY_ABSOLUTE_PATH: "freshFileExplorer.copyAbsolutePath",
  COPY_RELATIVE_PATH: "freshFileExplorer.copyRelativePath",
  COPY_FILENAME: "freshFileExplorer.copyFilename",
  COPY_SUBTREE_STRUCTURE: "freshFileExplorer.copySubtreeStructure",
  COPY_REMOTE_URL: "freshFileExplorer.copyRemoteUrl",

  // Pathspec filter
  SET_REPO_PATHSPEC: "freshFileExplorer.setRepoPathspec",

  // Folder scope (display-only filter, no git reload)
  SCOPE_TO_FOLDER: "freshFileExplorer.scopeToFolder",
  CLEAR_FOLDER_SCOPE: "freshFileExplorer.clearFolderScope",

  // Submodule navigation
  FOCUS_SUBMODULE_REPO: "freshFileExplorer.focusSubmoduleRepo",

  // Reveal active file in tree
  REVEAL_ACTIVE_FILE: "freshFileExplorer.revealActiveFile",

  // Compare selected files
  COMPARE_SELECTED: "freshFileExplorer.compareSelected",

  // Rename
  RENAME_FILE: "freshFileExplorer.renameFile",

  // Branch compare view
  BRANCH_COMPARE_OPEN_MODE_CHANGES: "freshFileExplorer.branchCompare.openMode.changes",
  BRANCH_COMPARE_OPEN_MODE_FILE: "freshFileExplorer.branchCompare.openMode.file",
  BRANCH_COMPARE_OPEN: "freshFileExplorer.branchCompare.open",
  BRANCH_COMPARE_OPEN_FILE: "freshFileExplorer.branchCompare.openFile",
  BRANCH_COMPARE_OPEN_TO_SIDE: "freshFileExplorer.branchCompare.openToSide",
  BRANCH_COMPARE_OPEN_AT_BASELINE: "freshFileExplorer.branchCompare.openAtBaseline",
  BRANCH_COMPARE_REFRESH: "freshFileExplorer.branchCompare.refresh",
  BRANCH_COMPARE_REFRESH_REPO: "freshFileExplorer.branchCompare.refreshRepo",
  BRANCH_COMPARE_SET_BASELINE: "freshFileExplorer.branchCompare.setBaseline",
  BRANCH_COMPARE_CLEAR_BASELINE: "freshFileExplorer.branchCompare.clearBaseline",
  BRANCH_COMPARE_OPEN_ALL: "freshFileExplorer.branchCompare.openAll",
  BRANCH_COMPARE_RESTORE_FROM_BASELINE: "freshFileExplorer.branchCompare.restoreFromBaseline",
  BRANCH_COMPARE_COPY_SUBTREE_STRUCTURE: "freshFileExplorer.branchCompare.copySubtreeStructure",
  BRANCH_COMPARE_REVEAL_IN_FRESH_FILES: "freshFileExplorer.branchCompare.revealInFreshFiles",
  BRANCH_COMPARE_OPEN_SETTINGS: "freshFileExplorer.branchCompare.openSettings",
  BRANCH_COMPARE_TOGGLE_ACTIVE: "freshFileExplorer.branchCompare.toggleActive",
  BRANCH_COMPARE_SWAP_SIDES: "freshFileExplorer.branchCompare.swapSides",
} as const;