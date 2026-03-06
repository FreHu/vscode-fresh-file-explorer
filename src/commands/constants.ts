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
  OPEN_FILE: "freshFileExplorer.openFile",
  OPEN_CHANGES: "freshFileExplorer.openChanges",
  OPEN_TO_SIDE: "freshFileExplorer.openToSide",
  DISCARD_CHANGES: "freshFileExplorer.discardChanges",
  DELETE_FILE: "freshFileExplorer.deleteFile",
  REVEAL_IN_SOURCE_CONTROL: "freshFileExplorer.revealInSourceControl",
  TOGGLE_OPEN_MODE: "freshFileExplorer.toggleOpenMode",
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

  // Heatmap command
  TOGGLE_HEATMAP: "freshFileExplorer.toggleHeatmap",

  // Diff search commands
  OPEN_DIFF_SEARCH_PANEL: "freshFileExplorer.openDiffSearchPanel",
  OPEN_DIFF_MATCH: "freshFileExplorer.openDiffMatch",
  CLEAR_DIFF_SEARCH: "freshFileExplorer.clearDiffSearch",

  // Git log -L (line / function history)
  GIT_LOG_L: "freshFileExplorer.gitLogL",

  // Git log for entire file history
  GIT_LOG_FILE: "freshFileExplorer.gitLogFile",

  // Git pickaxe search (-S): open diff search panel prefilled with selection
  GIT_PICKAXE: "freshFileExplorer.gitPickaxe",

  // Performance benchmark panel
  PERF_BENCHMARK: "freshFileExplorer.perfBenchmark",

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
} as const;
