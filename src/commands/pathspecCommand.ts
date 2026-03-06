import * as vscode from "vscode";
import * as path from "path";
import { FreshFileItem, FreshFilesTreeItem } from "../fresh-files/freshFileTreeItems";
import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { asNormalizedRepoPath, NormalizedRepoPath } from "../pathTypes";
import { normalizePath } from "../utils";
import { log } from "../extension/logger";
import { ConfigService } from "../config/configService";
import { WorkspaceStateManager } from "../extension/workspaceStateManager";

/**
 * Prompt the user to set (or clear) a git log pathspec for the given repo node.
 * Shows a quick pick with recent pathspecs (numbered) + option to enter a new one.
 * An empty selection clears any active pathspec for that repo.
 */
export async function handleSetRepoPathspec(
  item: FreshFileItem,
  freshFileProvider: FreshFileProvider,
): Promise<void> {
  const repoPath = item.resourceUri.fsPath;
  const normalizedRepoPath = asNormalizedRepoPath(repoPath);

  // Look up any currently active pathspec for pre-filling the input box.
  const currentPathspec = freshFileProvider.getRepoPathspec(normalizedRepoPath);

  // Get pathspec history
  const history = WorkspaceStateManager.getPathspecHistory();
  
  // Build quick pick items with numbered labels for fuzzy matching
  const items: vscode.QuickPickItem[] = [];
  
  // Add recent pathspecs with numbers
  history.forEach((pathspec, index) => {
    items.push({
      label: `${index + 1}. ${pathspec}`,
      description: currentPathspec === pathspec ? "(current)" : undefined,
      picked: currentPathspec === pathspec,
    });
  });
  
  // Add option to enter new pathspec
  items.push({
    label: "$(add) Enter new pathspec...",
    description: currentPathspec && !history.includes(currentPathspec) 
      ? `current: ${currentPathspec}` 
      : undefined,
  });
  
  // Add option to clear pathspec if one is active
  if (currentPathspec) {
    items.push({
      label: "$(remove) Clear pathspec",
      description: "Remove the current pathspec filter",
    });
  }

  // Show quick pick
  const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem>();
  quickPick.items = items;
  quickPick.canSelectMany = false;
  quickPick.title = "Set Git Log Pathspec Filter";
  quickPick.placeholder = "Select a recent pathspec or enter a new one";
  
  // Match by number for fast selection
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;

  const selected = await new Promise<vscode.QuickPickItem | undefined>(resolve => {
    quickPick.onDidAccept(() => {
      resolve(quickPick.selectedItems[0]);
      quickPick.hide();
    });
    quickPick.onDidHide(() => {
      resolve(undefined);
      quickPick.dispose();
    });
    quickPick.show();
  });

  // Handle selection
  if (!selected) {
    log("setRepoPathspec: cancelled");
    return;
  }

  // Check if user wants to enter new pathspec
  if (selected.label.includes("Enter new pathspec")) {
    await showPathspecInputBox(normalizedRepoPath, currentPathspec, freshFileProvider);
    return;
  }

  // Check if user wants to clear pathspec
  if (selected.label.includes("Clear pathspec")) {
    freshFileProvider.setRepoPathspec(normalizedRepoPath, undefined);
    return;
  }

  // User selected a historical pathspec - extract it from the label (remove "1. " prefix)
  const pathspec = selected.label.replace(/^\d+\.\s*/, "");
  
  // Add to history and set
  WorkspaceStateManager.addPathspecToHistory(pathspec);
  freshFileProvider.setRepoPathspec(normalizedRepoPath, pathspec);
}

/**
 * Shows an input box for entering a new pathspec.
 */
async function showPathspecInputBox(
  normalizedRepoPath: NormalizedRepoPath,
  currentPathspec: string | undefined,
  freshFileProvider: FreshFileProvider,
): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: "Set Git Log Pathspec Filter",
    prompt:
      "Enter a pathspec to restrict git log to specific files or directories. " +
      "Leave empty to clear the filter.",
    value: currentPathspec ?? "",
    placeHolder: "e.g. src/  or  *.ts  or  :(exclude)*.test.ts",
    validateInput: (value) => {
      // Basic sanity check — pathspecs shouldn't start with a dash (looks like a flag)
      // if an invalid value is passed that causes a git error, the pathspec will be cleared and the tree reloaded
      if (value.trimStart().startsWith("-")) {
        return "Pathspec must not start with a dash.";
      }
      return undefined;
    },
  });

  // undefined means the user pressed Escape — do nothing
  if (input === undefined) {
    log("setRepoPathspec: cancelled");
    return;
  }

  const trimmedInput = input.trim();
  
  // Add to history if non-empty
  if (trimmedInput) {
    WorkspaceStateManager.addPathspecToHistory(trimmedInput);
  }
  
  freshFileProvider.setRepoPathspec(normalizedRepoPath, trimmedInput || undefined);
}

/**
 * Scope the tree display to the clicked folder (display-only, no git reload).
 * Finds the repo that owns the folder and sets a folder scope filter on it.
 * After scoping, expands the folder to the configured auto-expand depth.
 */
export async function handleScopeToFolder(
  item: FreshFileItem,
  freshFileProvider: FreshFileProvider,
  treeView: vscode.TreeView<FreshFilesTreeItem>,
): Promise<void> {
  const folderPath = item.resourceUri.fsPath;
  const normalizedFolderPath = normalizePath(folderPath);

  // Find the repo that owns this folder
  const repoInfo = findRepoForFolder(normalizedFolderPath, freshFileProvider);
  if (!repoInfo) {
    log(`scopeToFolder: could not find repo for folder ${normalizedFolderPath}`, "warn");
    return;
  }

  log(`Scoping to folder: ${normalizedFolderPath} (repo: ${repoInfo.normalizedRepoPath})`);
  freshFileProvider.setFolderScope(repoInfo.normalizedRepoPath, normalizedFolderPath);

  // Expand the folder to the configured auto-expand depth.
  const depth = ConfigService.getAutoExpandDepth();
  if (depth > 0) {
    try {
      await treeView.reveal(item, { expand: depth, focus: false, select: false });
    } catch (error) {
      log(`scopeToFolder: could not reveal folder: ${error}`, "warn");
    }
  }
}

/**
 * Clear the folder scope for the repo of the clicked item (repo root or any item within it).
 */
export function handleClearFolderScope(
  item: FreshFileItem,
  freshFileProvider: FreshFileProvider,
): void {
  const itemPath = normalizePath(item.resourceUri.fsPath);

  // If the item is a repo root, use it directly; otherwise find the owning repo
  const repoInfo = findRepoForFolder(itemPath, freshFileProvider) ?? { normalizedRepoPath: itemPath as NormalizedRepoPath };
  log(`Clearing folder scope for repo: ${repoInfo.normalizedRepoPath}`);
  freshFileProvider.setFolderScope(repoInfo.normalizedRepoPath, undefined);
}

/**
 * Find the normalized repo path that contains the given normalized folder path.
 */
function findRepoForFolder(
  normalizedFolderPath: string,
  freshFileProvider: FreshFileProvider,
): { normalizedRepoPath: NormalizedRepoPath } | undefined {
  for (const folder of freshFileProvider.workspaceFolders) {
    for (const repoRelPath of folder.gitRepos) {
      const repoFullPath = repoRelPath
        ? normalizePath(path.join(folder.path, repoRelPath)) as NormalizedRepoPath
        : normalizePath(folder.path) as NormalizedRepoPath;
      if (
        normalizedFolderPath === repoFullPath ||
        normalizedFolderPath.startsWith(repoFullPath + "/")
      ) {
        return { normalizedRepoPath: repoFullPath };
      }
    }
  }
  return undefined;
}
