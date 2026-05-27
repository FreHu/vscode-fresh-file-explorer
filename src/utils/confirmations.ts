import * as vscode from "vscode";

import { ConfigService } from "../config/configService";

/**
 * "you sure?" prompt for bulk actions that open / restore / discard a
 * lot of files at once. Below the threshold, returns `true` without prompting.
 *
 * The threshold defaults to the user-configured
 * `freshFileExplorer.bulkActionConfirmThreshold` setting. Callers can pass an
 * explicit `threshold` override to ignore the user setting (e.g. when an
 * action is destructive enough to always warrant confirmation regardless).
 *
 * Returns true when the user confirms, false otherwise.
 */
export async function confirmBulkAction(options: {
  count: number;
  threshold?: number;
  /** Button verb (e.g. "Open All", "Restore"). Default "Continue". */
  actionLabel?: string;
  /** Override the default prompt. */
  message?: string;
  /** Optional secondary line shown beneath the prompt. */
  detail?: string;
}): Promise<boolean> {
  const threshold = options.threshold ?? ConfigService.getBulkActionConfirmThreshold();
  if (options.count <= threshold) { return true; }

  const actionLabel = options.actionLabel ?? "Continue";
  const message = options.message ?? `${options.count} is a lot of files. You sure about this?`;

  const choice = await vscode.window.showWarningMessage(
    message,
    { modal: true, detail: options.detail },
    actionLabel,
    "Cancel",
  );
  return choice === actionLabel;
}
