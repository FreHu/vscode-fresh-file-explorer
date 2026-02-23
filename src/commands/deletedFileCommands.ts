import * as vscode from "vscode";
import * as path from "path";
import { log } from "../utils/logger";
import { getFileFromHistoryAsBuffer } from "../git/gitOperations";
import { FreshFileItem } from "../treeItems";
import { normalizePath } from "../utils";
import { WorkspaceFolderProvider, RefreshableProvider, findRepoForFile } from "../types";
import { asAbsolutePath } from "../pathTypes";

/**
 * Interface for a provider that can work with deleted files
 */
export interface DeletedFileProvider extends WorkspaceFolderProvider, RefreshableProvider {}

/**
 * Helper function to get deleted file content as Buffer (for binary/non-UTF8 files)
 */
async function getDeletedFileContentAsBuffer(
  item: FreshFileItem,
  provider: DeletedFileProvider,
): Promise<{ content: Buffer; relativePath: string } | undefined> {
  const workspaceFolders = provider.workspaceFolders;
  if (workspaceFolders.length === 0) {
    vscode.window.showErrorMessage("No workspace folder open");
    return undefined;
  }

  // Find which workspace folder this file belongs to
  const folder = provider.findWorkspaceFolderForPath(asAbsolutePath(item.resourceUri.fsPath));
  if (!folder) {
    vscode.window.showErrorMessage("Could not determine workspace folder for file");
    return undefined;
  }

  const relativePath = normalizePath(path.relative(folder.path, item.resourceUri.fsPath));

  // Determine which git repository this file belongs to within the folder
  const repoLocation = findRepoForFile(folder, relativePath);
  if (!repoLocation) {
    return undefined;
  }

  // For pending deletions, use HEAD. For historical, use the commit before deletion.
  const ref = item.commitHash ? `${item.commitHash}~1` : "HEAD";

  const content = await getFileFromHistoryAsBuffer(repoLocation.repoFullPath, repoLocation.filePathInRepo, ref);
  return { content, relativePath };
}

export async function handleExhume(item: FreshFileItem, provider: DeletedFileProvider): Promise<void> {
  if (!item || !item.resourceUri || !item.isDeleted) {
    return;
  }

  try {
    log(`Viewing deleted file: ${item.resourceUri.fsPath}`);

    // Get file as buffer to preserve binary content
    const result = await getDeletedFileContentAsBuffer(item, provider);
    if (!result) {
      return;
    }

    const fileName = path.basename(item.resourceUri.fsPath);

    // Save to temp file and open - VS Code auto-detects language/encoding
    // Use consistent naming based on relative path to reuse temp files
    const os = await import("os");
    const fs = await import("fs");
    const crypto = await import("crypto");
    const tempDir = path.join(os.tmpdir(), "fresh-file-explorer");
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Create a short hash of the path for uniqueness without long filenames
    const pathHash = crypto.createHash("md5").update(result.relativePath).digest("hex");
    const tempFile = path.join(tempDir, `${pathHash}-${fileName}`);
    await fs.promises.writeFile(tempFile, result.content);

    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(tempFile));
    log(`Opened deleted file from temp: ${tempFile}`);
  } catch (error) {
    const errorMsg = String(error);
    log(`Failed to view deleted file: ${errorMsg}`, "error");
    vscode.window.showErrorMessage(`Failed to view deleted file: ${errorMsg}`);
  }
}

export async function handleResurrect(
  item: FreshFileItem,
  selectedItems: FreshFileItem[] | undefined,
  provider: DeletedFileProvider,
): Promise<void> {
  const workspaceFolders = provider.workspaceFolders;
  if (workspaceFolders.length === 0) {
    vscode.window.showErrorMessage("No workspace folder open");
    return;
  }

  // Get items to resurrect - filter to deleted files only
  const allItems = selectedItems && selectedItems.length > 0 ? selectedItems : item ? [item] : [];
  const deletedItems = allItems.filter(i => i && i.resourceUri && i.isDeleted && !i.isDirectory);

  if (deletedItems.length === 0) {
    return;
  }

  const fs = await import("fs");
  const errors: string[] = [];
  let successCount = 0;

  // Process each file - fetch content and write
  for (const fileItem of deletedItems) {
    const fileName = path.basename(fileItem.resourceUri.fsPath);

    // Don't overwrite an existing file
    // HOWEVER, this should be impossible - if a file exists in the same location as a deleted file, it would not show up in the tree as deleted
    // so you shouldn't have the resurrect option available at all
    if (fs.existsSync(fileItem.resourceUri.fsPath)) {
      log(`Resurrect skipped - file already exists: ${fileItem.resourceUri.fsPath}`, "warn");
      errors.push(fileName + " (already exists)");
      continue;
    }

    try {
      log(`Resurrecting deleted file: ${fileItem.resourceUri.fsPath}`);

      // Find workspace folder and repo
      const folder = provider.findWorkspaceFolderForPath(asAbsolutePath(fileItem.resourceUri.fsPath));
      if (!folder) {
        log(`Could not find workspace folder for: ${fileItem.resourceUri.fsPath}`, "error");
        errors.push(fileName + " (no workspace folder)");
        continue;
      }

      const relativePath = normalizePath(path.relative(folder.path, fileItem.resourceUri.fsPath));
      const repoLocation = findRepoForFile(folder, relativePath);
      if (!repoLocation) {
        errors.push(fileName + " (no repo found)");
        continue;
      }

      // Use git checkout to restore the file - this respects .gitattributes and core.autocrlf
      // which properly handles line endings, while git show gives raw bytes
      const ref = fileItem.commitHash ? `${fileItem.commitHash}~1` : "HEAD";

      // Import child_process for git restore
      const { execFile } = await import("child_process");
      const { promisify } = await import("util");
      const execFilePromise = promisify(execFile);

      try {
        await execFilePromise("git", ["restore", "--source=" + ref, "--", repoLocation.filePathInRepo], {
          cwd: repoLocation.repoFullPath,
        });
        log(`Resurrected ${fileName} using git restore from ${ref}`);
        successCount++;
      } catch (gitError) {
        log(`Git checkout failed for ${fileName}, falling back to manual write: ${gitError}`, "warn");

        // Fallback: use buffer version if git checkout fails
        const result = await getDeletedFileContentAsBuffer(fileItem, provider);
        if (!result) {
          errors.push(fileName + " (content not found)");
          continue;
        }

        const dirPath = path.dirname(fileItem.resourceUri.fsPath);
        await fs.promises.mkdir(dirPath, { recursive: true });
        await fs.promises.writeFile(fileItem.resourceUri.fsPath, result.content);
        successCount++;
      }
    } catch (error) {
      const errorMsg = String(error);
      log(`Failed to resurrect file ${fileName}: ${errorMsg}`, "error");
      errors.push(fileName);
    }
  }

  // Show results
  if (successCount > 0) {
    if (successCount === 1 && deletedItems.length === 1) {
      // Open the single resurrected file
      await vscode.commands.executeCommand("vscode.open", deletedItems[0].resourceUri);
    }
    provider.refresh();
  }

  if (errors.length > 0) {
    vscode.window.showErrorMessage(`Failed to resurrect file(s): ${errors.join(", ")}`);
  }
}
