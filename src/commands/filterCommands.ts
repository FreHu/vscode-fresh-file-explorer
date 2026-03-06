import { log, showInfo } from "../extension/logger";
import { createAuthorQuickPick, createCommitQuickPick } from "../utils/quickPick";
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

  return new Promise((resolve) => {
    const filterManager = dataProvider.filterManager;
    const quickPick = createAuthorQuickPick(authors, filterManager.getExcludedAuthors());

    let resolved = false;

    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems;
      const selectedAuthors = new Set(selected.map(i => i.author));

      const excluded = setDifference(
        authors.map(a => a.author),
        selectedAuthors,
      );

      filterManager.setExcludedAuthors(excluded);
      updateFilterContext(filterManager);

      quickPick.hide();
      if (!resolved) {
        resolved = true;
        resolve(true); // Selection made
      }
    });

    quickPick.onDidHide(() => {
      if (!resolved) {
        resolved = true;
        resolve(false); // Cancelled
      }
      quickPick.dispose();
    });

    quickPick.show();
  });
}

export async function handleFilterByCommit(dataProvider: FreshFileProvider): Promise<boolean> {
  log("Filter by commit command triggered");
  const commits = dataProvider.getAvailableCommits();

  if (commits.length === 0) {
    showInfo("No commits found in current view");
    return false;
  }

  return new Promise((resolve) => {
    const filterManager = dataProvider.filterManager;
    const quickPick = createCommitQuickPick(commits, filterManager.getExcludedCommits());

    let resolved = false;

    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems;
      const selectedHashes = new Set(selected.map(i => i.hash));
      const excluded = setDifference(
        commits.map(a => a.hash),
        selectedHashes,
      );

      filterManager.setExcludedCommits(excluded);
      updateFilterContext(filterManager);

      quickPick.hide();
      if (!resolved) {
        resolved = true;
        resolve(true); // Selection made
      }
    });

    quickPick.onDidHide(() => {
      if (!resolved) {
        resolved = true;
        resolve(false); // Cancelled
      }
      quickPick.dispose();
    });

    quickPick.show();
  });
}

export function handleClearFilters(filterManager: FilterManager): void {
  log("Clear filters command triggered");
  filterManager.clearFilters();
  updateFilterContext(filterManager);
}
