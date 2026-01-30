import * as vscode from "vscode";
import { log } from "../utils/logger";
import { createAuthorQuickPick, createCommitQuickPick } from "../utils/quickPick";
import { setDifference } from "../utils";
import { AuthorData, CommitDataWithFileCount, CommitHash } from "../types";

/**
 * Interface for a provider that can filter files by author or commit
 */
export interface FilterProvider {
  getAvailableAuthors(): AuthorData[];
  getAvailableCommits(): CommitDataWithFileCount[];
  setExcludedAuthors(authors: Set<string>): void;
  setExcludedCommits(commits: Set<CommitHash>): void;
  clearFilters(): void;
  hasActiveFilters(): boolean;
  excludedAuthors: Set<string>;
  excludedCommits: Set<CommitHash>;
}

/**
 * Update the context key for filter visibility
 */
function updateFilterContext(provider: FilterProvider): void {
  vscode.commands.executeCommand("setContext", "freshFileExplorer.hasFilters", provider.hasActiveFilters());
}

export async function handleFilterByAuthor(filterProvider: FilterProvider): Promise<void> {
  log("Filter by author command triggered");
  const authors = filterProvider.getAvailableAuthors();

  if (authors.length === 0) {
    vscode.window.showInformationMessage("No authors found in current view");
    return;
  }

  const quickPick = createAuthorQuickPick(authors, filterProvider.excludedAuthors);
  quickPick.onDidAccept(() => {
    const selected = quickPick.selectedItems;
    const selectedAuthors = new Set(selected.map(i => i.author));

    const excluded = setDifference(
      authors.map(a => a.author),
      selectedAuthors,
    );

    filterProvider.setExcludedAuthors(excluded);
    updateFilterContext(filterProvider);

    quickPick.hide();
  });

  quickPick.show();
}

export async function handleFilterByCommit(filterProvider: FilterProvider): Promise<void> {
  log("Filter by commit command triggered");
  const commits = filterProvider.getAvailableCommits();

  if (commits.length === 0) {
    vscode.window.showInformationMessage("No commits found in current view");
    return;
  }

  // Get currently excluded commits to mark them properly
  const currentExcluded = (filterProvider as any).excludedCommits || new Set<CommitHash>();
  const quickPick = createCommitQuickPick(commits, currentExcluded);
  quickPick.onDidAccept(() => {
    const selected = quickPick.selectedItems;
    const selectedHashes = new Set(selected.map(i => i.hash));
    const excluded = setDifference(
      commits.map(a => a.hash),
      selectedHashes,
    );

    filterProvider.setExcludedCommits(excluded);
    updateFilterContext(filterProvider);

    quickPick.hide();
  });

  quickPick.show();
}

export function handleClearFilters(filterProvider: FilterProvider): void {
  log("Clear filters command triggered");
  filterProvider.clearFilters();
  updateFilterContext(filterProvider);
}
