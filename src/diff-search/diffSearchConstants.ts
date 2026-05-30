/**
 * Context values for diff-search result tree items. Kept in a vscode-free
 * module so the package.json drift test can verify that every `viewItem`
 * referenced in a `when` clause is a contextValue the code actually produces.
 */
export const DiffSearchContextValues = {
  FILE: "diffSearchFile",
  MATCH: "diffSearchMatch",
  REPO: "diffSearchRepo",
  COMMIT: "diffSearchCommit",
  PENDING: "diffSearchPending",
} as const;
