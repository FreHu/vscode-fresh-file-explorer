import * as vscode from "vscode";
import * as path from "path";

import { FreshFileItem } from "../fresh-files/freshFileTreeItems";
import { log } from "../extension/logger";
import { gitUri } from "../git/gitOperations";
import { openDiff } from "../utils";
import { shortSha } from "../utils/formatUtils";

/**
 * Handler for opening files in diff/changes mode
 * Shows committed files as diff between commit and parent
 * Shows pending files as diff against HEAD
 */
export async function handleOpenChanges(
  item: FreshFileItem,
  selectedItems?: FreshFileItem[],
  options?: { preserveFocus?: boolean },
): Promise<void> {
  log(`OPEN_CHANGES command triggered`);
  const items = selectedItems && selectedItems.length > 0 ? selectedItems : item ? [item] : [];
  const preserveFocus = options?.preserveFocus ?? false;
  log(`Processing ${items.length} items, preserveFocus: ${preserveFocus}`);

  for (const fileItem of items) {
    if (fileItem && fileItem.resourceUri && !fileItem.isDirectory) {
      const fileName = path.basename(fileItem.resourceUri.fsPath);
      try {
        if (fileItem.commitHash) {
          // Check if the file was newly added (status 'A' or starts with 'A')
          const isNewlyAdded = fileItem.status?.startsWith("A");

          if (isNewlyAdded) {
            // For newly added files, just open the file from that commit
            // (can't show diff since parent doesn't have it)
            const fileUri = gitUri(fileItem.resourceUri, fileItem.commitHash);            
            await vscode.commands.executeCommand("vscode.open", fileUri, {
              preserveFocus,
              preview: preserveFocus,
            });
          } else {
            // For modified files, show diff between commit and its parent
            const leftRef = `${fileItem.commitHash}~1`;
            const rightRef = fileItem.commitHash;

            const leftUri = gitUri(fileItem.resourceUri, leftRef);
            const rightUri = gitUri(fileItem.resourceUri, rightRef);
            const title = `${fileName} (${shortSha(fileItem.commitHash)}^ ↔ ${shortSha(
              fileItem.commitHash,
            )})`;

            await openDiff(leftUri, rightUri, title, {
              preserveFocus,
              preview: preserveFocus,
            });
          }
        } else if (fileItem.isPending) {
          // For pending changes (no commit hash), show diff against HEAD
          // git.openChange doesn't support preserveFocus directly, but we can refocus the tree after
          await vscode.commands.executeCommand("git.openChange", fileItem.resourceUri);
          if (preserveFocus) {
            // Refocus the tree view
            await vscode.commands.executeCommand("freshFileExplorer.focus");
          }
        } else {
          // No commit info, just open the file
          log(`No commit hash or pending status for ${fileItem.resourceUri.fsPath}, opening file instead`, "warn");
          await vscode.commands.executeCommand("vscode.open", fileItem.resourceUri, {
            preserveFocus,
            preview: preserveFocus,
          });
        }
      } catch (error) {
        log(`Failed to open changes for ${fileItem.resourceUri.fsPath}: ${error}`, "error");
        // Fallback to just opening the file
        await vscode.commands.executeCommand("vscode.open", fileItem.resourceUri);
      }
    }
  }
}