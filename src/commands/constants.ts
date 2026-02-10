/**
 * Command IDs used throughout the Fresh File Explorer extension
 */
export const Commands = {
  // Main commands
  REFRESH: "freshFileExplorer.refresh",
  SET_TIME_WINDOW: "freshFileExplorer.setTimeWindow",
  SET_GROUPING_MODE: "freshFileExplorer.setGroupingMode",
  SHOW_OUTPUT: "freshFileExplorer.showOutput",
  EXPAND_ALL: "freshFileExplorer.expandAll",
  EXPAND_SUBTREE: "freshFileExplorer.expandSubtree",

  // Filter commands
  FILTER_BY_AUTHOR: "freshFileExplorer.filterByAuthor",
  FILTER_BY_COMMIT: "freshFileExplorer.filterByCommit",
  CLEAR_FILTERS: "freshFileExplorer.clearFilters",

  // Search commands
  SEARCH_IN_FRESH_FILES: "freshFileExplorer.searchInFreshFiles",
  SEARCH_IN_SEARCH_RESULTS: "freshFileExplorer.searchInFoundFiles",

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
  REVEAL_IN_SOURCE_CONTROL: "freshFileExplorer.revealInSourceControl",
  TOGGLE_OPEN_MODE: "freshFileExplorer.toggleOpenMode",

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
} as const;
