import * as vscode from "vscode";
import * as path from "path";
import { FreshFileProvider } from "../freshFileProvider";
import { FreshFileItem } from "../treeItems";
import { log } from "../utils/logger";
import { asAbsolutePath } from "../pathTypes";
import { isPathWithinRoot } from "../git/gitOperations";

/**
 * Handles the "New File Here" command - creates a new file as a sibling to the selected file
 */
export async function handleCreateFileNextTo(
  item: FreshFileItem,
  selectedItems: FreshFileItem[] | undefined,
  provider: FreshFileProvider,
): Promise<void> {
  try {
    // Always use the primary item (multi-select doesn't make sense for file creation)
    const targetPath = item.resourceUri.fsPath;
    
    // Get parent directory of the file
    const parentDir = path.dirname(targetPath);
    
    // Find workspace folder for validation
    const folder = provider.findWorkspaceFolderForPath(asAbsolutePath(targetPath));
    if (!folder) {
      vscode.window.showErrorMessage("Could not determine workspace folder for this file");
      log(`Failed to find workspace folder for ${targetPath}`, "error");
      return;
    }

    // Validate parent directory is within workspace
    if (!isPathWithinRoot(asAbsolutePath(parentDir), folder.path)) {
      vscode.window.showErrorMessage("Cannot create file outside workspace");
      log(`Path traversal attempt blocked: ${parentDir}`, "warn");
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

    // Parse input: split by comma and process paths
    const items = input.split(",").map(item => item.trim()).filter(item => item.length > 0);
    
    if (items.length === 0) {
      return;
    }

    // Extract base directory from first item (if it has one)
    const firstItem = items[0];
    const firstItemDir = firstItem.includes("/") || firstItem.includes("\\") 
      ? path.dirname(firstItem) 
      : "";

    // Build full paths for all items
    const filePaths: string[] = [];
    for (const item of items) {
      let fullPath: string;
      
      // If item has its own path separators, use it as-is (relative to parent)
      // Otherwise, inherit the base directory from the first item
      if (item.includes("/") || item.includes("\\")) {
        fullPath = path.join(parentDir, item.replace(/\//g, path.sep));
      } else if (firstItemDir) {
        fullPath = path.join(parentDir, firstItemDir, item);
      } else {
        fullPath = path.join(parentDir, item);
      }

      // Validate each path is within workspace
      if (!isPathWithinRoot(asAbsolutePath(fullPath), folder.path)) {
        vscode.window.showErrorMessage(`Cannot create file outside workspace: ${item}`);
        log(`Path traversal attempt blocked: ${fullPath}`, "warn");
        return;
      }

      // Check if file already exists
      const fs = require("fs");
      if (fs.existsSync(fullPath)) {
        vscode.window.showErrorMessage(`File already exists: ${item}`);
        return;
      }

      filePaths.push(fullPath);
    }

    // Create all files
    const fs = await import("fs");
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
    provider.refresh();

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Failed to create file: ${errorMsg}`);
    log(`Error creating file: ${errorMsg}`, "error");
  }
}
