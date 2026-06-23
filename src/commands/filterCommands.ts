import { log, showInfo } from "../extension/logger";
import { createAuthorQuickPick, createCommitQuickPick } from "../utils/quickPick";
import { runQuickPickPromise } from "./commandUtils";
import { setDifference } from "../utils/collectionUtils";
import { ContextManager } from "../extension/contextManager";
import { FilterManager } from "../fresh-files/freshFileFilterManager";
import { FreshFileProvider } from "../fresh-files/freshFileProvider";


/**
 * Update the context key for filter visibility
 */
function updateFilterContext(filterManager: FilterManager): void {
  ContextManager.setHasFilters(filterManager.hasActiveFilters());
}

export async function handleFilterByAuthor(dataProvider: FreshFileProvider): Promise<boolean> {
  log("Filter by author command triggered");
  const authors = dataProvider.getAvailableAuthors();

  if (authors.length === 0) {
    showInfo("No authors found in current view");
    return false;
  }

  const filterManager = dataProvider.filterManager;
  const quickPick = createAuthorQuickPick(authors, filterManager.getExcludedAuthors());

  return runQuickPickPromise(quickPick, (qp) => {
    const selectedAuthors = new Set(qp.selectedItems.map(i => i.author));
    const excluded = setDifference(
      authors.map(a => a.author),
      selectedAuthors,
    );

    filterManager.setExcludedAuthors(excluded);
    updateFilterContext(filterManager);
  });
}

export async function handleFilterByCommit(dataProvider: FreshFileProvider): Promise<boolean> {
  log("Filter by commit command triggered");
  const commits = dataProvider.getAvailableCommits();

  if (commits.length === 0) {
    showInfo("No commits found in current view");
    return false;
  }

  const filterManager = dataProvider.filterManager;
  const quickPick = createCommitQuickPick(commits, filterManager.getExcludedCommits());

  return runQuickPickPromise(quickPick, (qp) => {
    const selectedHashes = new Set(qp.selectedItems.map(i => i.hash));
    const excluded = setDifference(
      commits.map(a => a.hash),
      selectedHashes,
    );

    filterManager.setExcludedCommits(excluded);
    updateFilterContext(filterManager);
  });
}

export function handleClearFilters(filterManager: FilterManager): void {
  log("Clear filters command triggered");
  filterManager.clearFilters();
  updateFilterContext(filterManager);
}
