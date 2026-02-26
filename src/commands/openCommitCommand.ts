import * as vscode from "vscode";
import * as path from "path";

import { FreshFileItem } from "../treeItems";
import { FreshFileProvider } from "../freshFileProvider";
import { log } from "../extension/logger";
import { gitUri, getCommitChanges, getCommitParent, getCommitSubject } from "../git/gitOperations";
import { asAbsolutePath } from "../pathTypes";
import { findRepoForFile } from "../types";
import { normalizePath } from "../utils";
import { findWorkspaceFolderForPath } from "../utils/pathUtils";

/**
 * Opens all changes from a commit in VS Code's multi-diff editor.
 * This replicates the "Open All Changes" behavior from the Timeline view.
 */
export async function handleOpenCommit(
  item: FreshFileItem,
  freshFileProvider: FreshFileProvider,
): Promise<void> {
  if (!item?.commitHash) {
    log("Open commit: no commit hash available", "warn");
    return;
  }

  const commitHash = item.commitHash;
  log(`Open commit: ${commitHash}`);

  // Find the repo this file belongs to
  const filePath = asAbsolutePath(normalizePath(item.resourceUri.fsPath));
  const folder = findWorkspaceFolderForPath(filePath, freshFileProvider.workspaceFolders);
  if (!folder) {
    log(`Open commit: could not find workspace folder for ${filePath}`, "warn");
    return;
  }

  const relativePath = normalizePath(path.relative(folder.path, filePath));
  const repoLocation = findRepoForFile(folder, relativePath);
  if (!repoLocation) {
    log(`Open commit: could not find repo for ${filePath}`, "warn");
    return;
  }

  const repoRoot = repoLocation.repoFullPath;

  try {
    // Get parent commit (for diffing)
    const parentHash = await getCommitParent(repoRoot, commitHash);

    // Get commit subject for the title
    const commitSubject = await getCommitSubject(repoRoot, commitHash);
    const shortHash = commitHash.substring(0, 7);
    const title = `${shortHash} - ${commitSubject}`;

    // Get the list of changed files
    const changes = await getCommitChanges(repoRoot, commitHash);
    if (changes.length === 0) {
      vscode.window.showInformationMessage(`No changes found in commit ${shortHash}.`);
      return;
    }

    // Build the resources array for the multi-diff editor  
    // Each resource has an originalUri (before) and modifiedUri (after)
    const resources: { originalUri?: vscode.Uri; modifiedUri?: vscode.Uri }[] = [];

    // Identify the file to reveal (robust path comparison)
    const targetPath = normalizePath(item.resourceUri.fsPath);
    let revealModifiedUri: vscode.Uri | undefined;

    for (const change of changes) {
      const changeFullPath = path.join(repoRoot, change.filePath);
      const fileUri = vscode.Uri.file(changeFullPath);

      let resource: { originalUri?: vscode.Uri; modifiedUri?: vscode.Uri };

      switch (change.status) {
        case "A":
          // Added file: no original, only modified
          resource = {
            originalUri: undefined,
            modifiedUri: gitUri(fileUri, commitHash),
          };
          break;
        case "D":
          // Deleted file: only original, no modified
          resource = {
            originalUri: gitUri(fileUri, parentHash ?? commitHash),
            modifiedUri: undefined,
          };
          break;
        case "R":
        case "C": {
          // Renamed/copied: original path at parent ref, new path at commit ref
          const originalFileUri = vscode.Uri.file(path.join(repoRoot, change.originalFilePath!));
          resource = {
            originalUri: gitUri(originalFileUri, parentHash ?? commitHash),
            modifiedUri: gitUri(fileUri, commitHash),
          };
          break;
        }
        default:
          // Modified (M, T, etc.): show diff between parent and commit
          resource = {
            originalUri: gitUri(fileUri, parentHash ?? commitHash),
            modifiedUri: gitUri(fileUri, commitHash),
          };
          break;
      }

      resources.push(resource);

      // Check if this is the file we want to reveal
      if (resource.modifiedUri && normalizePath(changeFullPath) === targetPath) {
        revealModifiedUri = resource.modifiedUri;
      }
    }

    // Build a unique URI for this multi-diff source so VS Code can track/reuse it
    const parentId = parentHash ?? "root";
    const multiDiffSourceUri = vscode.Uri.from({
      scheme: "scm-history-item",
      path: `${repoRoot}/${parentId}..${commitHash}`,
    });

    // Reveal the file that was right-clicked (if it's in the changes)
    const reveal = revealModifiedUri ? { modifiedUri: revealModifiedUri } : undefined;

    log(`Opening multi-diff editor for commit ${shortHash} with ${resources.length} files`);

    // ¯\(ツ)/¯ this api is unstable ¯\(ツ)/¯
    await vscode.commands.executeCommand("_workbench.openMultiDiffEditor", {
      multiDiffSourceUri,
      title,
      resources,
      reveal,
    });
  } catch (error: any) {
    log(`Failed to open commit ${commitHash}: ${error.message}`, "error");
    vscode.window.showErrorMessage(`Failed to open commit: ${error.message}`);
  }
}
