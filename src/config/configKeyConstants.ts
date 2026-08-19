/** Settings namespace — every config key must live under `${CONFIG_SECTION}.`. */
export const CONFIG_SECTION = "freshFileExplorer";

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
  BLAME_HEATMAP_AUTO_APPLY: "freshFileExplorer.blameHeatmap.autoApply",
  BLAME_HEATMAP_BG_OPACITY: "freshFileExplorer.blameHeatmap.backgroundOpacity",
  BLAME_HEATMAP_MAX_LINES: "freshFileExplorer.blameHeatmap.maxFileLines",

  // Auto-reveal active file
  AUTO_REVEAL: "freshFileExplorer.autoReveal",

  // Default grouping mode (used when no workspace state is persisted yet)
  DEFAULT_GROUPING_MODE: "freshFileExplorer.defaultGroupingMode",

  // Default sort order (used when no workspace state is persisted yet)
  DEFAULT_SORT_ORDER: "freshFileExplorer.defaultSortOrder",

  // Default open-changes mode (used when no workspace state is persisted yet)
  DEFAULT_OPEN_CHANGES_MODE: "freshFileExplorer.defaultOpenChangesMode",

  // Flat list label style
  FLAT_LIST_LABEL_STYLE: "freshFileExplorer.flatList.labelStyle",

  // Code Telescope integration
  CODE_TELESCOPE_INTEGRATION: "freshFileExplorer.codeTelescopeIntegration",

  // Rename behavior
  AUTO_STAGE_RENAME: "freshFileExplorer.autoStageRename",

  // Branch compare diff editor side preference
  BRANCH_COMPARE_WORKING_TREE_SIDE: "freshFileExplorer.branchCompare.workingTreeSide",

  // Bulk-action confirmation threshold (Open All Changes, Open All Found Files, etc.)
  BULK_ACTION_CONFIRM_THRESHOLD: "freshFileExplorer.bulkActionConfirmThreshold",

  // Status-bar visibility toggles
  STATUS_BAR_LOADING: "freshFileExplorer.statusBar.loading",
  STATUS_BAR_HEATMAP: "freshFileExplorer.statusBar.heatmap",

  // Smallest version bump worth an update notification (patch | minor | major)
  NOTIFY_ON: "freshFileExplorer.notifyOn",

  // Hide files matching each workspace folder's `files.exclude` setting
  RESPECT_FILES_EXCLUDE: "freshFileExplorer.respectFilesExclude",

  // Additional Co-authored-by emails to treat as AI agents (in-house/custom agents)
  AI_COAUTHOR_EMAILS: "freshFileExplorer.aiCoAuthorEmails",

  // Auto-create a live branch-compare section for each diverged repo/worktree
  AUTO_FOLLOW: "freshFileExplorer.branchCompare.autoFollow",
} as const;
