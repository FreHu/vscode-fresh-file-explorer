import * as vscode from "vscode";
import * as path from "path";
import { DiffSearchResultProvider } from "../diffSearchResultProvider";
import { DiffSearchMatchItem } from "../diffSearchTreeItems";
import { gitUri } from "../git/gitOperations";

/**
 * Open a diff match in the editor
 */
export async function handleOpenDiffMatch(matchItem: DiffSearchMatchItem): Promise<void> {
  try {
    const fileName = path.basename(matchItem.filePath);
    
    // Convert normalized path (forward slashes) back to OS format for URI creation
    const osPath = process.platform === "win32" 
      ? matchItem.filePath.replace(/\//g, "\\")
      : matchItem.filePath;

    if (matchItem.commitHash) {
      
      const rightRef = matchItem.commitHash;
      const rightUri = gitUri(vscode.Uri.file(osPath), rightRef);

      const commitShort = matchItem.commitHash.substring(0, 7);
      
      if (matchItem.fileAdded) {
        // Open just the new file version, as there's no parent to compare against
        const title = `${fileName} (new in ${commitShort})`;
        
        const doc = await vscode.workspace.openTextDocument(rightUri);
        await vscode.window.showTextDocument(doc, {
          selection: new vscode.Range(matchItem.lineNumber - 1, 0, matchItem.lineNumber - 1, 0),
          preview: true,
        });
      } else {
        // Historical change - show diff between commit and parent
        const leftRef = `${matchItem.commitHash}~1`;
        const leftUri = gitUri(vscode.Uri.file(osPath), leftRef);
        const title = `${fileName} (${commitShort}^ ↔ ${commitShort})`;

        // Open the diff with selection
        await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title, {
          preserveFocus: false,
          preview: true,
          selection:
            matchItem.changeType === "added"
              ? new vscode.Range(matchItem.lineNumber - 1, 0, matchItem.lineNumber - 1, 0)
              : undefined,
        });

        // For removed lines, try to focus on the left side
        if (matchItem.changeType === "removed") {
          // Give VS Code time to open the diff editor
          setTimeout(async () => {
            try {
              await vscode.commands.executeCommand("workbench.action.compareEditor.focusPrimarySide");
            } catch (err) {
              // Ignore - command might not be available
            }
          }, 100);
        }
      }
    } else if (matchItem.isStaged !== undefined) {
      // Pending change
      const uri = vscode.Uri.file(osPath);

      if (matchItem.isStaged) {
        // Staged change - compare HEAD with index
        const leftUri = gitUri(uri, "HEAD");
        const rightUri = gitUri(uri, "~"); // Index (staged)
        const title = `${fileName} (Index)`;

        await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title, {
          preserveFocus: false,
          preview: true,
          selection:
            matchItem.changeType === "added"
              ? new vscode.Range(matchItem.lineNumber - 1, 0, matchItem.lineNumber - 1, 0)
              : undefined,
        });
      } else {
        // Unstaged change - use git.openChange command
        await vscode.commands.executeCommand("git.openChange", uri);
      }
    } else {
      // Fallback - just open the file
      const doc = await vscode.workspace.openTextDocument(osPath);
      await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(matchItem.lineNumber - 1, 0, matchItem.lineNumber - 1, 0),
        preview: true,
      });
    }

  } catch (error: any) {
    vscode.window.showErrorMessage(`Failed to open diff: ${error.message || error}`);
  }
}

/**
 * Clear diff search results
 */
export async function handleClearDiffSearch(diffSearchResultProvider: DiffSearchResultProvider): Promise<void> {
  diffSearchResultProvider.clear();
  vscode.window.showInformationMessage("Diff search results cleared");
}
