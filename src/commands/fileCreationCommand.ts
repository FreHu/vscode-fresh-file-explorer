import * as vscode from "vscode";
import * as path from "path";
import { FreshFileProvider } from "../freshFileProvider";
import { FreshFileItem } from "../treeItems";
import { log } from "../utils/logger";
import { asAbsolutePath } from "../pathTypes";
import { findWorkspaceFolderForPath, isPathWithinRoot } from "../utils/pathUtils";

export type ResolveInputToPathsResult =
  | { kind: "paths"; paths: string[] }
  | { kind: "error"; message: string; isTraversalAttempt: boolean };

/**
 * Pure function: parses a comma-separated filename input and resolves each name to an
 * absolute path under `targetDir`. Validates all paths are within `workspaceRootPath`.
 *
 * Multiple bare names (no path separators) after the first one **inherit** the
 * subdirectory specified by the first name, e.g. "src/a.ts,b.ts" → ["src/a.ts","src/b.ts"].
 */
export function resolveInputToPaths(
  input: string,
  targetDir: string,
  workspaceRootPath: string,
): ResolveInputToPathsResult {
  const names = input.split(",").map(n => n.trim()).filter(n => n.length > 0);

  if (names.length === 0) {
    return { kind: "error", message: "No filenames provided", isTraversalAttempt: false };
  }

  // Extract base subdirectory from first item (if it carries one)
  const firstItem = names[0];
  const firstItemDir = firstItem.includes("/") || firstItem.includes("\\")
    ? path.dirname(firstItem)
    : "";

  const resolvedPaths: string[] = [];

  for (const name of names) {
    let fullPath: string;

    // If the name carries its own path separators use it as-is (relative to targetDir),
    // otherwise inherit the base subdirectory from the first item.
    if (name.includes("/") || name.includes("\\")) {
      fullPath = path.join(targetDir, name.replace(/\//g, path.sep));
    } else if (firstItemDir) {
      fullPath = path.join(targetDir, firstItemDir, name);
    } else {
      fullPath = path.join(targetDir, name);
    }

    if (!isPathWithinRoot(asAbsolutePath(fullPath), asAbsolutePath(workspaceRootPath))) {
      return {
        kind: "error",
        message: `Cannot create file outside workspace: ${name}`,
        isTraversalAttempt: true,
      };
    }

    resolvedPaths.push(fullPath);
  }

  return { kind: "paths", paths: resolvedPaths };
}

/**
 * Core implementation: prompts for filename(s) and creates them in the given directory.
 */
async function createFilesInDirectory(
  targetDir: string,
  workspaceRootPath: string,
  provider: FreshFileProvider,
): Promise<void> {
  // Validate target directory is within workspace
  if (!isPathWithinRoot(asAbsolutePath(targetDir), asAbsolutePath(workspaceRootPath))) {
    vscode.window.showErrorMessage("Cannot create file outside workspace");
    log(`Path traversal attempt blocked: ${targetDir}`, "warn");
    return;
  }

  // Prompt for filename(s)
  const input = await vscode.window.showInputBox({
    prompt: "Enter file name(s)",
    placeHolder: "file.txt or folder/file.tsx or file1.ts,file2.ts",
    validateInput: (value) => {
      if (!value || value.trim().length === 0) {
        return "Filename cannot be empty";
      }
      return null;
    }
  });

  if (!input || input.trim().length === 0) {
    return; // User cancelled
  }

  const resolved = resolveInputToPaths(input, targetDir, workspaceRootPath);
  if (resolved.kind === "error") {
    vscode.window.showErrorMessage(resolved.message);
    if (resolved.isTraversalAttempt) {
      log(`Path traversal attempt blocked: ${resolved.message}`, "warn");
    }
    return;
  }

  const filePaths = resolved.paths;

  // Create all files
  const fs = await import("fs");

  // Check existence for all resolved paths before creating any
  for (const filePath of filePaths) {
    if (fs.existsSync(filePath)) {
      vscode.window.showErrorMessage(`File already exists: ${path.basename(filePath)}`);
      return;
    }
  }

  const createdFiles: string[] = [];

  for (const filePath of filePaths) {
    const fileDir = path.dirname(filePath);
    await fs.promises.mkdir(fileDir, { recursive: true });
    await fs.promises.writeFile(filePath, "");
    createdFiles.push(filePath);
    log(`Created new file: ${filePath}`);
  }

  // Open the first file in the editor
  if (createdFiles.length > 0) {
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(createdFiles[0]));
  }

  // Refresh the tree to show the new files (if they fall within the time window)
  provider.refreshPending();
}

/**
 * Handles the "New File Here" command - creates a new file as a sibling to the selected
 * file or folder (i.e. in the same parent directory).
 */
export async function handleCreateFileNextTo(
  item: FreshFileItem,
  selectedItems: FreshFileItem[] | undefined,
  provider: FreshFileProvider,
): Promise<void> {
  try {
    const targetPath = item.resourceUri.fsPath;
    // For both files and folders: place the new file alongside (in the parent directory)
    const targetDir = path.dirname(targetPath);

    const folder = findWorkspaceFolderForPath(asAbsolutePath(targetPath), provider.workspaceFolders);
    if (!folder) {
      vscode.window.showErrorMessage("Could not determine workspace folder for this item");
      log(`Failed to find workspace folder for ${targetPath}`, "error");
      return;
    }

    await createFilesInDirectory(targetDir, folder.path, provider);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Failed to create file: ${errorMsg}`);
    log(`Error creating file: ${errorMsg}`, "error");
  }
}

/**
 * Handles the "New File Inside" command - creates a new file inside the selected folder.
 */
export async function handleCreateFileInside(
  item: FreshFileItem,
  selectedItems: FreshFileItem[] | undefined,
  provider: FreshFileProvider,
): Promise<void> {
  try {
    const targetDir = item.resourceUri.fsPath;

    const folder = findWorkspaceFolderForPath(asAbsolutePath(targetDir), provider.workspaceFolders);
    if (!folder) {
      vscode.window.showErrorMessage("Could not determine workspace folder for this folder");
      log(`Failed to find workspace folder for ${targetDir}`, "error");
      return;
    }

    await createFilesInDirectory(targetDir, folder.path, provider);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Failed to create file: ${errorMsg}`);
    log(`Error creating file: ${errorMsg}`, "error");
  }
}
