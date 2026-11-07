import * as vscode from "vscode";
import { formatCommitTooltip } from "./formatUtils";
import { getCommitMessage } from "../git/gitCommitQueries";
import { log } from "../extension/logger";

type CommitTooltipFields = Parameters<typeof formatCommitTooltip>[0];

const deferred = new WeakMap<vscode.TreeItem, CommitTooltipFields>();

/**
 * Leaves the tooltip unset so VS Code asks `resolveTreeItem` for it on hover,
 * which then loads the full message. `resolveTreeItem` only fills properties
 * that are undefined.
 */
export function deferCommitTooltip(item: vscode.TreeItem, fields: CommitTooltipFields): void {
  item.tooltip = undefined;
  deferred.set(item, fields);
}

/** Fills a deferred commit tooltip; falls back to the subject without a repo or when git fails. */
export async function resolveCommitTooltip(item: vscode.TreeItem, repoFullPath: string | undefined): Promise<vscode.TreeItem> {
  const fields = deferred.get(item);
  if (!fields || item.tooltip !== undefined) { return item; }
  let message = fields.message;
  if (repoFullPath) {
    try {
      message = await getCommitMessage(repoFullPath, fields.hash);
    } catch (error) {
      log(`Commit tooltip: could not read the message of ${fields.hash}: ${error instanceof Error ? error.message : String(error)}`, "warn");
    }
  }
  item.tooltip = formatCommitTooltip({ ...fields, message });
  return item;
}
