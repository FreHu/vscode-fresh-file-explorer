// Single source of truth for the VS Code "when"-clause context keys this
// extension sets via `setContext`. Kept vscode-free so the drift test can
// import it in plain Node (no Extension Host) and assert that every context
// key referenced in a package.json `when` clause is one of these.
//
// Set these only through ContextManager — never call setContext with a raw
// string. A key set here but spelled differently in a `when` clause silently
// disables the menu/binding; the drift test catches that mismatch.
//
// NOTE: built-in keys we merely mirror (e.g. `explorerResourceIsFolder`) are
// intentionally NOT listed here — we don't own them.
export const ContextKeys = {
  /** Tree is loading data from Git. */
  LOADING: "freshFileExplorer.loading",
  /** "Open changes" mode — click opens a diff rather than the file. */
  OPEN_CHANGES_MODE: "freshFileExplorer.openChangesMode",
  /** Branch Compare's own "open changes" mode — click opens the diff vs the file. Independent of the Fresh Files one. */
  BRANCH_COMPARE_OPEN_CHANGES_MODE: "freshFileExplorer.branchCompare.openChangesMode",
  /** fsPath of the selected item, exposed for other extensions (e.g. GitLens). */
  SELECTED_FILE: "freshFileExplorer.selectedFile",
  /** Any author/commit filter is active. */
  HAS_FILTERS: "freshFileExplorer.hasFilters",
  /** Internal file clipboard holds something (drives the Paste menu item). */
  HAS_CLIPBOARD: "freshFileExplorer.hasClipboard",
  /** The clipboard holds a cut (move) rather than a copy. */
  CLIPBOARD_IS_CUT: "freshFileExplorer.clipboardIsCut",
  /** At least one branch-compare entry is active. */
  BRANCH_COMPARE_HAS_ACTIVE_COMPARISON: "freshFileExplorer.branchCompare.hasActiveComparison",
  /** The diff-search results tree has results. */
  DIFF_SEARCH_HAS_RESULTS: "diffSearchResults.hasResults",
  /** Results-side change-type filter: "all" | "added" | "removed". Drives the toolbar toggle. */
  DIFF_SEARCH_CHANGE_FILTER: "diffSearchResults.changeFilter",
  /** Blame heatmap is active for the current editor. */
  BLAME_HEATMAP_ACTIVE: "freshFileExplorer.blameHeatmap.active",
  /** A saved baseline ref exists for the current editor. */
  BLAME_HEATMAP_HAS_BASE_REF: "freshFileExplorer.blameHeatmap.hasBaseRef",
  /** 1-based editor line numbers that have deletions (for `editorLineNumber in …`). */
  BLAME_HEATMAP_DELETION_LINES: "freshFileExplorer.blameHeatmap.deletionLines",
} as const;

/** Namespaces that identify a contributed id — context key, submenu, command —
 *  as one this extension owns. Used by the drift test to tell our identifiers
 *  apart from built-in keys / view ids we neither declare nor control. */
export const OWNED_NAMESPACES = ["freshFileExplorer."] as const;
