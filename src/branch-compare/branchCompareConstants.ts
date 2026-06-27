/**
 * Context values for the branch-compare tree. Kept distinct from the fresh
 * files tree's context values so menu contributions don't overlap, and in a
 * vscode-free module so the package.json drift test can verify that every
 * `viewItem` referenced in a `when` clause is a contextValue the code produces.
 */
export const BranchCompareContextValues = {
  REPO_SECTION: "freshFileExplorer.branchCompare.repoSection",
  FOLDER: "freshFileExplorer.branchCompare.folder",
  FILE: "freshFileExplorer.branchCompare.file",
  FILE_DELETED: "freshFileExplorer.branchCompare.deletedFile",
  EMPTY: "freshFileExplorer.branchCompare.empty",
  MESSAGE: "freshFileExplorer.branchCompare.message",
  GROUP: "freshFileExplorer.branchCompare.group",
  GROUP_COMMIT: "freshFileExplorer.branchCompare.groupCommit",
  /** The pending/uncommitted bucket — distinct so it can carry working-tree actions (e.g. focus Source Control). */
  GROUP_PENDING: "freshFileExplorer.branchCompare.groupPending",
} as const;

/**
 * Group key + label for the bucket that collects uncommitted / unattributed
 * entries in every non-File-Structure grouping mode. Shared so the grouping
 * builder and any code that needs to recognise the pending bucket agree.
 */
export const PENDING_GROUP_KEY = "(Pending)";

/**
 * How a comparison's diff is computed against its target ref:
 * - `merge`: diff against the merge-base of target and source (PR-style — what
 *   source *adds* since it diverged from target). The default.
 * - `full`: diff directly against the target ref (the exact `target..source`
 *   delta, including changes that come from target moving ahead).
 *
 * For ancestrally-related refs (e.g. `HEAD~5`..`HEAD`) the two modes coincide.
 */
export type DiffMode = "merge" | "full";

export const DEFAULT_DIFF_MODE: DiffMode = "merge";
