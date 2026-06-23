import * as vscode from "vscode";
import * as path from "path";
import { DiffSearchResultProvider } from "../diff-search/diffSearchResultProvider";
import { DiffSearchMatchItem, DiffSearchCommitItem, DiffSearchFileItem, DiffSearchRepoItem } from "../diff-search/diffSearchTreeItems";
import { gitUri } from "../git/gitOperations";
import { DiffSearchPanel } from "../diff-search/diffSearchPanel";
import { showError, showInfo } from "../extension/logger";
import { shortSha } from "../utils/formatUtils";

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

      const commitShort = shortSha(matchItem.commitHash);
      
      if (matchItem.fileAdded) {
        // Open just the new file version, as there's no parent to compare against        
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
        if (matchItem.changeType === "added") {
          await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title, {
            preserveFocus: false,
            preview: true,
            selection: new vscode.Range(matchItem.lineNumber - 1, 0, matchItem.lineNumber - 1, 0),
          });
        } else {
          // Removed line - vscode.diff selection applies to the right side, so we open
          // without selection, then find the left-side editor by URI and navigate there directly.
          await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title, {
            preserveFocus: false,
            preview: true,
          });
          await vscode.commands.executeCommand("workbench.action.compareEditor.focusPrimarySide");
          const leftEditor = vscode.window.visibleTextEditors.find(
            e => e.document.uri.toString() === leftUri.toString()
          );
          if (leftEditor) {
            const pos = new vscode.Position(matchItem.lineNumber - 1, 0);
            leftEditor.selection = new vscode.Selection(pos, pos);
            leftEditor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
          }
        }
      }
    } else if (matchItem.isStaged !== undefined) {
      // Pending change
      const uri = vscode.Uri.file(osPath);

      if (matchItem.fileAdded) {
        // Untracked file - open directly at the matched line (no diff available)
        const doc = await vscode.workspace.openTextDocument(osPath);
        await vscode.window.showTextDocument(doc, {
          selection: new vscode.Range(matchItem.lineNumber - 1, 0, matchItem.lineNumber - 1, 0),
          preview: true,
        });
      } else if (matchItem.isStaged) {
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
        // Unstaged change - compare index with working tree
        const leftUri = gitUri(uri, "~"); // Index (staged/current committed)
        const title = `${fileName} (Working Tree)`;

        await vscode.commands.executeCommand("vscode.diff", leftUri, uri, title, {
          preserveFocus: false,
          preview: true,
          selection:
            matchItem.changeType === "added"
              ? new vscode.Range(matchItem.lineNumber - 1, 0, matchItem.lineNumber - 1, 0)
              : undefined,
        });
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
    showError(`Failed to open diff: ${error.message || error}`);
  }
}

/**
 * Clear diff search results
 */
export async function handleClearDiffSearch(diffSearchResultProvider: DiffSearchResultProvider): Promise<void> {
  diffSearchResultProvider.clear();
  showInfo("Diff search results cleared");
}

/** Copy a result commit's full SHA to the clipboard (silent — matches the path-copy commands). */
export async function handleCopyDiffCommitSha(item: DiffSearchCommitItem): Promise<void> {
  if (item?.commitHash) {
    await vscode.env.clipboard.writeText(item.commitHash);
  }
}

/** Copy a matched line's content to the clipboard. */
export async function handleCopyDiffMatchLine(item: DiffSearchMatchItem): Promise<void> {
  if (item?.lineContent !== undefined) {
    await vscode.env.clipboard.writeText(item.lineContent);
  }
}

/** Copy a result file's path (already normalized to forward slashes) to the clipboard. */
export async function handleCopyDiffPath(item: DiffSearchFileItem | DiffSearchMatchItem): Promise<void> {
  if (item?.filePath) {
    await vscode.env.clipboard.writeText(item.filePath);
  }
}

/** "Expand All" on a repo or commit node — expand its whole subtree from cached matches. */
export function handleDiffSearchExpandAll(
  provider: DiffSearchResultProvider,
  item: DiffSearchRepoItem | DiffSearchCommitItem,
): void {
  if (item instanceof DiffSearchRepoItem) {
    provider.expandAllUnderRepo(item);
  } else if (item instanceof DiffSearchCommitItem) {
    provider.expandAllUnderCommit(item);
  }
}

/**
 * Open the diff search panel prefilled with the current selection or word under cursor.
 * The user can then adjust parameters (days, regex, repos, etc.) before running.
 */
export async function handleGitPickaxe(
  extensionUri: vscode.Uri,
  resultProvider: DiffSearchResultProvider,
  workspaceFolders: readonly vscode.WorkspaceFolder[],
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  let pattern = "";
  if (editor) {
    const selected = editor.document.getText(editor.selection).trim();
    if (selected) {
      const lines = selected.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (lines.length > 1) {
        pattern = lines[0];
        showInfo(
          "Diff search is line-by-line — multiline selection was reduced to the first line."
        );
      } else {
        pattern = lines[0] ?? "";
      }
    } else {
      const wordRange = editor.document.getWordRangeAtPosition(editor.selection.active);
      if (wordRange) { pattern = editor.document.getText(wordRange).trim(); }
    }
  }
  DiffSearchPanel.createOrShow(extensionUri, resultProvider, workspaceFolders, pattern || undefined);
}
