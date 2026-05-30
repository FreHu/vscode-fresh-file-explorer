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
} as const;
