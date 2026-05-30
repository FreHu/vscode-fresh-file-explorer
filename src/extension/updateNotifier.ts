import * as vscode from "vscode";
import { ConfigService } from "../config/configService";
import { shouldNotify } from "./versionGate";

const STATE_KEY = "lastNotifiedVersion";

/**
 * Run once on activation. Compares the running version against the last one we
 * notified about (persisted in globalState, so it's shared across all windows
 * and survives restarts).
 *
 *   stored == none     → fresh install: store silently, never notify
 *   stored == current  → reload/restart: silent
 *   current  > stored  → update: store, then notify if the bump clears the threshold
 *   current  < stored  → downgrade: store, stay silent
 *
 * The threshold (`freshFileExplorer.notifyOn`, default `minor`) gates which
 * bumps are worth a toast — patch releases stay silent by default.
 */
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

  // Record immediately, before the (awaited) toast, so a reload mid-toast
  // doesn't notify twice.
  await context.globalState.update(STATE_KEY, currentVersion);

  if (!shouldNotify(lastVersion, currentVersion, ConfigService.getUpdateNotifyThreshold())) {
    return;
  }

  const action = await vscode.window.showInformationMessage(
    `Fresh File Explorer updated to v${currentVersion}`,
    "What's New"
  );

  if (action === "What's New") {
    const changelogUri = vscode.Uri.joinPath(context.extensionUri, "CHANGELOG.md");
    await vscode.commands.executeCommand("markdown.showPreview", changelogUri);
  }
}
