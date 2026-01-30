import * as vscode from "vscode";
import { isPendingChangesMode, TimeWindow } from "../timeWindowUtils";
import { AuthorData, CommitDataWithFileCount, CommitHash } from "../types";
import { dotsDots as truncateWithDots } from "../utils";

export interface CommitQuickPickItem extends vscode.QuickPickItem {
  hash: CommitHash;
}

export function createCommitQuickPick(
  commits: CommitDataWithFileCount[],
  excludedCommits: Set<CommitHash> = new Set()
): vscode.QuickPick<CommitQuickPickItem> {
  const items: CommitQuickPickItem[] = commits.map(c => {
    const repoPart = c.repoName ? `[${c.repoName}] ` : "";
    const isPicked = !excludedCommits.has(c.hash);
    return {
      label: `$(git-commit) ${c.hash}`,
      description: `${repoPart}${c.date.toLocaleDateString()} • ${c.fileCount} file(s) by ${c.author}`,
      detail: truncateWithDots(c.message),
      picked: isPicked,
      hash: c.hash,
    };
  });

  const quickPick = vscode.window.createQuickPick<CommitQuickPickItem>();
  quickPick.items = items;
  quickPick.selectedItems = items.filter(item => item.picked);
  quickPick.canSelectMany = true;
  quickPick.placeholder = "Select commits to show (uncheck to hide)";
  quickPick.title = "Filter by Commit";

  quickPick.onDidHide(() => {
    quickPick.dispose();
  });
  return quickPick;
}

export interface AuthorPickItem extends vscode.QuickPickItem {
  author: string;
}

export function createAuthorQuickPick(
  authors: AuthorData[],
  excludedAuthors: Set<string> = new Set()
): vscode.QuickPick<AuthorPickItem> {
  const items: AuthorPickItem[] = authors.map(a => {
    const isPicked = !excludedAuthors.has(a.author);
    return {
      label: a.author,
      description: `${a.fileCount} file(s)`,
      picked: isPicked,
      author: a.author,
    };
  });

  const quickPick = vscode.window.createQuickPick<AuthorPickItem>();
  quickPick.items = items;
  quickPick.selectedItems = items.filter(item => item.picked);
  quickPick.canSelectMany = true;
  quickPick.placeholder = "Select authors to show (uncheck to hide)";
  quickPick.title = "Filter by Author";

  quickPick.onDidHide(() => {
    quickPick.dispose();
  });

  return quickPick;
}

export interface TimeWindowPickItem extends vscode.QuickPickItem {
  timeWindow: TimeWindow;
}

export function createTimeWindowQuickPick(
  timeWindows: TimeWindow[],
  currentTimeWindow: TimeWindow,
): vscode.QuickPick<TimeWindowPickItem> {
  const isCurrent = (tw: TimeWindow) => {
    if (tw.type === "pending" && currentTimeWindow.type === "pending") {
      return true;
    }
    return tw.type === "historical" && currentTimeWindow.type === "historical" && tw.days === currentTimeWindow.days;
  };

  const items: TimeWindowPickItem[] = timeWindows.map(tw => ({
    description: isCurrent(tw)
      ? "(current)"
      : isPendingChangesMode(tw)
        ? "Uncommitted changes"
        : `Last ${tw.days} days`,
    picked: isCurrent(tw),
    timeWindow: tw,
    label: tw.label,
  }));

  const quickPick = vscode.window.createQuickPick<TimeWindowPickItem>();
  quickPick.items = items;
  quickPick.canSelectMany = false;
  quickPick.placeholder = "Select time window for fresh files";

  return quickPick;
}
