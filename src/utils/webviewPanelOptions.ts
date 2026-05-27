import * as vscode from "vscode";

/**
 * Minimal `localResourceRoots` for webview panels. All shipped assets
 * (bundled scripts + the copied codicons CSS/font) live under `media/`.
 */
export function getLocalResourceRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  return [vscode.Uri.joinPath(extensionUri, "media")];
}
