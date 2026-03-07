/**
 * Configuration keys used throughout the Fresh File Explorer extension
 */
export const ConfigKeys = {
  // Description format settings
  DESCRIPTION_SHOW_DATE: "freshFileExplorer.description.showDate",
  DESCRIPTION_SHOW_AUTHOR: "freshFileExplorer.description.showAuthor",
  DESCRIPTION_SHOW_COMMIT_HASH: "freshFileExplorer.description.showCommitHash",
  DESCRIPTION_SHOW_COMMIT_MESSAGE: "freshFileExplorer.description.showCommitMessage",
  DESCRIPTION_SHOW_STATUS: "freshFileExplorer.description.showStatus",
  DESCRIPTION_SHOW_LINE_CHANGES: "freshFileExplorer.description.showLineChanges",

  // General settings
  AUTO_EXPAND_DEPTH: "freshFileExplorer.autoExpandDepth",
  TIME_WINDOWS: "freshFileExplorer.timeWindows",
  GIT_TIMEOUT: "freshFileExplorer.gitTimeout",
  SHOW_CURRENT_BRANCH_SYNC: "freshFileExplorer.showCurrentBranchSync",
  SHOW_BASE_BRANCH_SYNC: "freshFileExplorer.showBaseBranchSync",
  SEARCH_PATTERN_MAX_LENGTH: "freshFileExplorer.searchPatternMaxLength",
  OPEN_SEARCH_IN_EDITOR: "freshFileExplorer.openSearchInEditor",

  // History loading
  INCREMENTAL_TREE_LOADING: "freshFileExplorer.incrementalTreeLoading",

  // Heatmap settings
  HEATMAP_ENABLED: "freshFileExplorer.heatmap.enabled",

  // Auto-reveal active file
  AUTO_REVEAL: "freshFileExplorer.autoReveal",

  // Default grouping mode (used when no workspace state is persisted yet)
  DEFAULT_GROUPING_MODE: "freshFileExplorer.defaultGroupingMode",

  // Default sort order (used when no workspace state is persisted yet)
  DEFAULT_SORT_ORDER: "freshFileExplorer.defaultSortOrder",

  // Flat list label style
  FLAT_LIST_LABEL_STYLE: "freshFileExplorer.flatList.labelStyle",
} as const;
