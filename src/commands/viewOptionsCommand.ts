import * as vscode from "vscode";
import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { log } from "../extension/logger";
import { handleSetGroupingMode, handleSetSortOrder } from "./basicCommands";
import { handleFilterAiAuthored, handleFilterByAuthor, handleFilterByCommit } from "./filterCommands";

/**
 * Handles the "View Options" command - shows a menu of view configuration options
 */
export async function handleViewOptions(freshFileProvider: FreshFileProvider): Promise<void> {
  await showViewOptionsMenu(freshFileProvider);
}

const options = [
  {
    label: "$(group-by-ref-type) Set Grouping Mode",
    description: "Change how files are organized (by structure, author, commit, etc.)",
    action: "grouping",
  },
  {
    label: "$(sort-precedence) Set Sort Order",
    description: "Change sorting within folders (name, date, author)",
    action: "sort",
  },
  {
    label: "$(person) Filter by Author",
    description: "Show only files from specific authors",
    action: "filterAuthor",
  },
  {
    label: "$(git-commit) Filter by Commit",
    description: "Show only files from specific commits",
    action: "filterCommit",
  },
  {
    label: "$(sparkle) Filter by AI Co-authorship",
    description: "Show only / hide changes co-authored by an AI agent",
    action: "filterAi",
  },
];

/**
 * Shows the view options menu and loops back after sub-menu closes
 */
async function showViewOptionsMenu(freshFileProvider: FreshFileProvider): Promise<void> {
  log("View options command triggered");

  const quickPick = vscode.window.createQuickPick();
  quickPick.title = "View Options";
  quickPick.placeholder = "Select a view option to configure";

  quickPick.items = options;

  quickPick.onDidAccept(async () => {
    const selected = quickPick.selectedItems[0] as any;
    quickPick.hide();

    if (!selected) {
      return;
    }

    // Call the appropriate handler based on selection
    let selectionMade = false;
    switch (selected.action) {
      case "grouping":
        selectionMade = await handleSetGroupingMode(freshFileProvider);
        break;
      case "sort":
        selectionMade = await handleSetSortOrder(freshFileProvider);
        break;
      case "filterAuthor":
        selectionMade = await handleFilterByAuthor(freshFileProvider);
        break;
      case "filterCommit":
        selectionMade = await handleFilterByCommit(freshFileProvider);
        break;
      case "filterAi":
        selectionMade = await handleFilterAiAuthored(freshFileProvider);
        break;
    }

    // Only show the View Options menu again if user cancelled (ESC) the sub-menu
    if (!selectionMade) {
      await showViewOptionsMenu(freshFileProvider);
    }
  });

  quickPick.show();
}
