import * as vscode from "vscode";

const STATE_KEY = "lastNotifiedVersion";

export async function checkForUpdate(context: vscode.ExtensionContext): Promise<void> {
  const currentVersion: string = context.extension.packageJSON.version;
  const lastVersion = context.globalState.get<string>(STATE_KEY);

  if (!lastVersion) {
    // First install — store version silently
    await context.globalState.update(STATE_KEY, currentVersion);
    return;
  }

  if (lastVersion === currentVersion) {
    return;
  }

  await context.globalState.update(STATE_KEY, currentVersion);

  const action = await vscode.window.showInformationMessage(
    `Fresh File Explorer updated to v${currentVersion}`,
    "What's New"
  );

  if (action === "What's New") {
    const changelogUri = vscode.Uri.joinPath(context.extensionUri, "CHANGELOG.md");
    await vscode.commands.executeCommand("markdown.showPreview", changelogUri);
  }
}
