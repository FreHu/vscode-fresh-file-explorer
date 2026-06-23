import * as vscode from "vscode";
import * as path from "path";
import { FreshFileItem, FreshFilesTreeItem } from "../fresh-files/freshFileTreeItems";
import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { showError } from "../extension/logger";
import { setClipboard, getClipboard, clearClipboard } from "./copyPasteService";
import { TreeItemContextValues } from "../fresh-files/treeItemConstants";
import { refreshPendingForFiles, resolveCommandSelection } from "./commandUtils";

function getItems(
  item: FreshFileItem,
  selectedItems: FreshFileItem[] | undefined,
  treeView?: vscode.TreeView<FreshFilesTreeItem>,
): FreshFileItem[] {
  // Keybinding path — fall back to the tree view's current selection.
  const treeSelection = treeView?.selection.filter((i): i is FreshFileItem => i instanceof FreshFileItem);
  return resolveCommandSelection(item, selectedItems, treeSelection);
}

/**
 * Stores the selected files in the extension clipboard for a subsequent paste (copy mode).
 */
export function handleCopyFile(
  item: FreshFileItem,
  selectedItems: FreshFileItem[] | undefined,
  treeView?: vscode.TreeView<FreshFilesTreeItem>,
): void {
  const items = getItems(item, selectedItems, treeView).filter(i => i?.resourceUri && !i.isDeleted);
  if (items.length === 0) {
    return;
  }
  const uris = items.map(i => i.resourceUri);
  setClipboard(uris, false);
}

/**
 * Stores the selected files in the extension clipboard for a subsequent paste (cut/move mode).
 */
export function handleCutFile(
  item: FreshFileItem,
  selectedItems: FreshFileItem[] | undefined,
  treeView?: vscode.TreeView<FreshFilesTreeItem>,
): void {
  const items = getItems(item, selectedItems, treeView).filter(i => i?.resourceUri && !i.isDeleted);
  if (items.length === 0) {
    return;
  }
  const uris = items.map(i => i.resourceUri);
  setClipboard(uris, true);
}

/**
 * Resolves the target directory for a paste operation from the clicked tree item.
 *
 * - Folder items → directory itself
 * - File items → parent directory
 * - null/undefined → returns null (cannot paste)
 */
function resolveTargetDirectory(item: FreshFileItem | undefined): vscode.Uri | null {
  if (!item?.resourceUri) {
    return null;
  }

  const folderContextValues: string[] = [
    TreeItemContextValues.FOLDER,
    TreeItemContextValues.WORKSPACE_FOLDER,
    TreeItemContextValues.REPO_FOLDER,
  ];

  if (item.isDirectory || folderContextValues.includes(item.contextValue as string)) {
    return item.resourceUri;
  }

  // File — paste into its parent directory
  return vscode.Uri.file(path.dirname(item.resourceUri.fsPath));
}

/**
 * Generates a unique destination URI when the desired name already exists.
 * Mirrors VS Code's "copy" naming convention:
 *   - file.ts → file copy.ts → file copy 2.ts → …
 *   - folder  → folder copy  → folder copy 2  → …
 */
async function generateUniqueName(targetDir: vscode.Uri, sourceName: string): Promise<vscode.Uri> {
  const ext = path.extname(sourceName);
  const base = path.basename(sourceName, ext);

  // Try "base copy.ext" first, then "base copy 2.ext", "base copy 3.ext", etc.
  let candidate = vscode.Uri.joinPath(targetDir, `${base} copy${ext}`);
  let counter = 2;

  while (true) {
    try {
      await vscode.workspace.fs.stat(candidate);
      // File exists — try next suffix
      candidate = vscode.Uri.joinPath(targetDir, `${base} copy ${counter}${ext}`);
      counter++;
    } catch {
      // stat threw → file does not exist → this name is available
      return candidate;
    }
  }
}

/**
 * Pastes the items currently in the extension clipboard into the folder represented
 * by `item`. Handles both copy and cut (move) modes, and resolves name conflicts.
 */
export async function handlePasteFile(
  item: FreshFileItem,
  _selectedItems: FreshFileItem[] | undefined,
  provider: FreshFileProvider,
  treeView?: vscode.TreeView<FreshFilesTreeItem>,
): Promise<void> {
  const clipboard = getClipboard();
  if (!clipboard || clipboard.uris.length === 0) {
    return;
  }

  // When triggered via keybinding, item is undefined — fall back to tree selection
  const effectiveItem =
    item ??
    treeView?.selection.find((i): i is FreshFileItem => i instanceof FreshFileItem);

  const targetDir = resolveTargetDirectory(effectiveItem);
  if (!targetDir) {
    showError("Cannot determine paste target", "No folder or file was selected.");
    return;
  }

  const errors: string[] = [];
  const moved: vscode.Uri[] = [];

  for (const sourceUri of clipboard.uris) {
    const sourceName = path.basename(sourceUri.fsPath);
    const normalizedSource = path.normalize(sourceUri.fsPath).toLowerCase();
    const normalizedTarget = path.normalize(targetDir.fsPath).toLowerCase();

    // Prevent pasting a folder into one of its own subfolders.
    if (normalizedTarget.startsWith(normalizedSource + path.sep)) {
      errors.push(`"${sourceName}" cannot be pasted here — the destination is inside the source folder.`);
      continue;
    }

    // If pasting a folder into itself, redirect to its parent — same-level copy behavior
    // (matches VS Code explorer: copy "utils", right-click "utils", paste → "utils copy").
    const effectiveTargetDir = normalizedTarget === normalizedSource
      ? vscode.Uri.file(path.dirname(targetDir.fsPath))
      : targetDir;

    let destUri = vscode.Uri.joinPath(effectiveTargetDir, sourceName);

    // Determine if the source and destination are in the same folder.
    const isSameFolder =
      path.normalize(path.dirname(sourceUri.fsPath)).toLowerCase() ===
      path.normalize(effectiveTargetDir.fsPath).toLowerCase();

    // Cut to the same folder is a no-op — skip silently.
    if (isSameFolder && clipboard.isCut) {
      continue;
    }

    try {
      if (isSameFolder && !clipboard.isCut) {
        // Copying into the same directory — always generate a new name
        destUri = await generateUniqueName(effectiveTargetDir, sourceName);
      } else {
        // Check if destination exists; resolve conflict if so
        try {
          await vscode.workspace.fs.stat(destUri);
          // Destination exists and it's not the source itself — resolve conflict
          if (destUri.fsPath.toLowerCase() !== sourceUri.fsPath.toLowerCase()) {
            destUri = await generateUniqueName(targetDir, sourceName);
          }
        } catch {
          // stat threw → destination does not exist → use original name as-is
        }
      }

      if (clipboard.isCut) {
        await vscode.workspace.fs.rename(sourceUri, destUri, { overwrite: false });
        moved.push(sourceUri);
      } else {
        await vscode.workspace.fs.copy(sourceUri, destUri, { overwrite: false });
      }
    } catch (err) {
      errors.push(`${sourceName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // If it was a cut, clear the clipboard now that all files have been moved
  if (clipboard.isCut && moved.length > 0) {
    clearClipboard();
  }

  if (errors.length > 0) {
    showError(
      errors.length === 1 ? errors[0] : `${errors.length} files failed to paste`,
      errors.join("\n"),
    );
  }

  // Refresh the tree so newly created/moved files appear
  // A cut (move) may affect both the source and destination repos.
  const affectedPaths = [
    targetDir.fsPath,
    ...(clipboard.isCut ? clipboard.uris.map(u => u.fsPath) : []),
  ];
  void refreshPendingForFiles(provider, affectedPaths);
}
