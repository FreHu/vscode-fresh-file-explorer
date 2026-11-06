import * as vscode from "vscode";

/**
 * Minimal `localResourceRoots` for webview panels. All shipped assets
 * (bundled scripts + the copied codicons CSS/font) live under `media/`.
 */
function getLocalResourceRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  return [vscode.Uri.joinPath(extensionUri, "media")];
}

/** What every webview here needs: scripts on, local resources limited to `media/`. */
export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: getLocalResourceRoots(extensionUri) };
}

/** Webview URIs of a bundled script under `media/` and of the codicons stylesheet. */
export function getWebviewAssetUris(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  scriptName: string,
): { scriptUri: string; codiconCssUri: string } {
  const media = (...segments: string[]) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", ...segments)).toString();
  return { scriptUri: media(scriptName), codiconCssUri: media("codicons", "codicon.css") };
}
