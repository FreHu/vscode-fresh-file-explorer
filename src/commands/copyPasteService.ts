import * as vscode from "vscode";
import { ContextManager } from "../extension/contextManager";

/**
 * In-memory clipboard for file copy/cut operations in the Fresh File Explorer.
 * VS Code's built-in clipboard is text-only; we maintain our own URI list.
 */
interface ClipboardEntry {
  uris: vscode.Uri[];
  /** true = cut (move), false = copy */
  isCut: boolean;
}

let clipboardEntry: ClipboardEntry | null = null;

/**
 * Stores files in the internal clipboard and updates context variables so the
 * "Paste" menu item appears.
 */
export function setClipboard(uris: vscode.Uri[], isCut: boolean): void {
  clipboardEntry = { uris, isCut };
  ContextManager.setClipboard(true, isCut);
}

/**
 * Returns the current clipboard contents, or null if nothing has been copied/cut.
 */
export function getClipboard(): ClipboardEntry | null {
  return clipboardEntry;
}

/**
 * Clears the clipboard and removes the paste context variable.
 */
export function clearClipboard(): void {
  clipboardEntry = null;
  ContextManager.setClipboard(false, false);
}
