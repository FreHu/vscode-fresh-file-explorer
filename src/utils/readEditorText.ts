import * as vscode from "vscode";

/** Reads a file as the editor would decode it (`files.encoding`, auto-guess, BOM). Throws on binary content. */
export async function readEditorText(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return vscode.workspace.decode(bytes, { uri });
}
