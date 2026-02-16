import * as vscode from "vscode";

/** Helper to normalize path separators to forward slashes */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Build a human-readable label for a number of days
 */
export function formatDaysLabel(days: number): string {
  const dayLabels: Record<number, string> = {
    [-1]: "Pending changes",
    1: "1 day",
    7: "1 week",
    14: "2 weeks",
    30: "1 month",
    60: "2 months",
    90: "3 months",
    180: "6 months",
    365: "1 year",
  };

  if (dayLabels.hasOwnProperty(days)) {
    return dayLabels[days];
  }

  return `${days} days`;
}

export function setDifference<T>(all: Iterable<T>, exclude: Set<T>): Set<T> {
  return new Set(Array.from(all).filter(x => !exclude.has(x)));
}

export function dotsDots(str: string, length = 80): string {
  return str.length > length ? str.substring(0, length - 3) + "..." : str;
}

/**
 * Opens a file, but if it's already open in any visible editor, focuses that editor instead of creating a duplicate tab.
 * This prevents the annoying behavior where clicking a file that's already open in another pane creates a second tab.
 */
export async function openFileWithoutDuplicating(
  uri: vscode.Uri,
  options?: {
    preserveFocus?: boolean;
    preview?: boolean;
    viewColumn?: vscode.ViewColumn;
  }
): Promise<void> {
  const { preserveFocus = false, preview = false, viewColumn } = options ?? {};
  
  // Check if the file is already open in any visible editor
  const existingEditor = vscode.window.visibleTextEditors.find(
    editor => editor.document.uri.toString() === uri.toString()
  );
  
  if (existingEditor) {
    // File is already open, focus the existing editor instead of opening a duplicate
    await vscode.window.showTextDocument(existingEditor.document, {
      viewColumn: existingEditor.viewColumn,
      preserveFocus,
      preview,
    });
  } else {
    // File is not open, open it normally
    if (viewColumn !== undefined) {
      await vscode.commands.executeCommand("vscode.open", uri, viewColumn);
    } else {
      await vscode.commands.executeCommand("vscode.open", uri, {
        preserveFocus,
        preview,
      });
    }
  }
}
