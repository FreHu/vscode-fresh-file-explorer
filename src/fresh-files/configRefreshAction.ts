// Maps a VS Code configuration change to the cheapest tree refresh that makes it
// visible. Extracted from FreshFileProvider so the mapping + escalation rule are
// unit-testable without a live workspace.
//
// Refresh hierarchy (cheapest → most expensive):
//   "none"     — handled outside freshFileProvider (heatmap, git timeout, etc.)
//   "treeOnly" — re-render from cached data; no git I/O
//   "pending"  — re-run git status + numstat; rebuilds from cached history baseline
//   "hard"     — full repo discovery + git log; only when history scope changes

import { ConfigKeys } from "../config/configKeyConstants";

export type RefreshAction = "none" | "treeOnly" | "pending" | "hard";

// The `Record<keyof typeof ConfigKeys, ...>` type makes this exhaustive: adding a
// new ConfigKey without classifying it here is a compile error.
//prettier-ignore
const CONFIG_ACTIONS: Record<keyof typeof ConfigKeys, RefreshAction> = {
  // History scope — must re-fetch git log data.
  TIME_WINDOWS:                    "hard",

  // Pending-path data — gates a git diff --numstat call.
  DESCRIPTION_SHOW_LINE_CHANGES:   "pending",

  // Display-only — all data is already cached.
  DESCRIPTION_SHOW_DATE:           "treeOnly",
  DESCRIPTION_SHOW_AUTHOR:         "treeOnly",
  DESCRIPTION_SHOW_COMMIT_HASH:    "treeOnly",
  DESCRIPTION_SHOW_COMMIT_MESSAGE: "treeOnly",
  DESCRIPTION_SHOW_STATUS:         "treeOnly",
  DEFAULT_GROUPING_MODE:           "treeOnly",
  DEFAULT_SORT_ORDER:              "treeOnly",
  FLAT_LIST_LABEL_STYLE:           "treeOnly",
  AUTO_EXPAND_DEPTH:               "treeOnly",
  SHOW_CURRENT_BRANCH_SYNC:        "treeOnly",
  SHOW_BASE_BRANCH_SYNC:           "treeOnly",
  INCREMENTAL_TREE_LOADING:        "treeOnly",

  // Handled elsewhere or behavioural only — no tree refresh needed.
  HEATMAP_ENABLED:                 "none",
  BLAME_HEATMAP_AUTO_APPLY:        "none",
  BLAME_HEATMAP_BG_OPACITY:        "none",
  BLAME_HEATMAP_MAX_LINES:         "none",
  AUTO_REVEAL:                     "none",
  GIT_TIMEOUT:                     "none",
  SEARCH_PATTERN_MAX_LENGTH:       "none",
  OPEN_SEARCH_IN_EDITOR:           "none",
  CODE_TELESCOPE_INTEGRATION:      "none",
  DEFAULT_OPEN_CHANGES_MODE:       "none",
  AUTO_STAGE_RENAME:               "none",
  STATUS_BAR_LOADING:              "none",
  STATUS_BAR_HEATMAP:              "none",
  BRANCH_COMPARE_WORKING_TREE_SIDE: "none",
  BULK_ACTION_CONFIRM_THRESHOLD:    "none",
  NOTIFY_ON:                       "none",

  // Display-only — recompute the exclude-filtered view; the provider rebuilds the
  // matcher cache + display map before the treeOnly refresh fires.
  RESPECT_FILES_EXCLUDE:           "treeOnly",
  AI_COAUTHOR_EMAILS:              "hard", // re-parse git log: changes which co-author trailers count as AI
};

/**
 * Resolve the cheapest refresh that covers every changed config key, escalating
 * to the most expensive action any changed key requires
 * (hard > pending > treeOnly > none).
 *
 * @param affects predicate equivalent to `ConfigurationChangeEvent.affectsConfiguration`.
 */
export function resolveConfigRefreshAction(affects: (section: string) => boolean): RefreshAction {
  let action: RefreshAction = "none";
  for (const [key, candidate] of Object.entries(CONFIG_ACTIONS) as [keyof typeof ConfigKeys, RefreshAction][]) {
    if (!affects(ConfigKeys[key])) { continue; }
    // Escalate to the most expensive action required by any changed key.
    if (candidate === "hard" || (candidate === "pending" && action !== "hard") || (candidate === "treeOnly" && action === "none")) {
      action = candidate;
    }
  }
  return action;
}
