import * as vscode from "vscode";
import { log, showInfo } from "../extension/logger";
import { createAuthorQuickPick, createCommitQuickPick } from "../utils/quickPick";
import { runQuickPickPromise } from "./commandUtils";
import { setDifference } from "../utils/collectionUtils";
import { ContextManager } from "../extension/contextManager";
import { AiFilterMode, FilterManager } from "../fresh-files/freshFileFilterManager";
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

/**
 * Show a 3-way picker for the AI co-authorship filter. Returns true if the user
 * picked an option (so the View Options menu doesn't reopen), false on ESC.
 */
export async function handleFilterAiAuthored(dataProvider: FreshFileProvider): Promise<boolean> {
  log("Filter by AI co-authorship command triggered");
  const filterManager = dataProvider.filterManager;
  const current = filterManager.getAiFilter();

  const items: (vscode.QuickPickItem & { mode: AiFilterMode })[] = [
    { mode: "all", label: "$(list-flat) Show all changes", description: "No AI filtering" },
    { mode: "only", label: "$(sparkle) Only AI co-authored", description: "Changes with a known AI-agent Co-authored-by trailer" },
    { mode: "hide", label: "$(circle-slash) Hide AI co-authored", description: "Only human-authored changes" },
  ];
  for (const item of items) {
    if (item.mode === current) {
      item.label = `$(check) ${item.label.replace(/^\$\([^)]+\)\s*/, "")}`;
    }
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: "Filter by AI Co-authorship",
    placeHolder: "Filter changes by whether an AI agent co-authored them",
  });
  if (!picked) {
    return false;
  }
  filterManager.setAiFilter(picked.mode);
  updateFilterContext(filterManager);
  return true;
}

export function handleClearFilters(filterManager: FilterManager): void {
  log("Clear filters command triggered");
  filterManager.clearFilters();
  updateFilterContext(filterManager);
}
