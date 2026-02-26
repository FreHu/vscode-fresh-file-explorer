import * as vscode from "vscode";
import { isPendingChangesMode, TimeWindow } from "../fresh-files/timeWindowUtils";
import { AuthorData, CommitDataWithFileCount, CommitHash } from "../types";
import { dotsDots } from "./formatUtils";

export interface CommitQuickPickItem extends vscode.QuickPickItem {
  hash: CommitHash;
}

export function buildCommitItems(
  commits: CommitDataWithFileCount[],
  excludedCommits: Set<CommitHash> = new Set(),
): CommitQuickPickItem[] {
  return commits.map(c => {
    const repoPart = c.repoName ? `[${c.repoName}] ` : "";
    const isPicked = !excludedCommits.has(c.hash);
    return {
      label: `$(git-commit) ${c.hash}`,
      description: `${repoPart}${c.date.toLocaleDateString()} • ${c.fileCount} file(s) by ${c.author}`,
      detail: dotsDots(c.message),
      picked: isPicked,
      hash: c.hash,
    };
  });
}

export function createCommitQuickPick(
  commits: CommitDataWithFileCount[],
  excludedCommits: Set<CommitHash> = new Set()
): vscode.QuickPick<CommitQuickPickItem> {
  const items = buildCommitItems(commits, excludedCommits);

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

export function buildAuthorItems(
  authors: AuthorData[],
  excludedAuthors: Set<string> = new Set(),
): AuthorPickItem[] {
  return authors.map(a => {
    const isPicked = !excludedAuthors.has(a.author);
    return {
      label: a.author,
      description: `${a.fileCount} file(s)`,
      picked: isPicked,
      author: a.author,
    };
  });
}

export function createAuthorQuickPick(
  authors: AuthorData[],
  excludedAuthors: Set<string> = new Set()
): vscode.QuickPick<AuthorPickItem> {
  const items = buildAuthorItems(authors, excludedAuthors);

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

export function buildTimeWindowItems(
  timeWindows: TimeWindow[],
  currentTimeWindow: TimeWindow,
): TimeWindowPickItem[] {
  const isCurrent = (tw: TimeWindow) => {
    if (tw.type === "pending" && currentTimeWindow.type === "pending") {
      return true;
    }
    return tw.type === "historical" && currentTimeWindow.type === "historical" && tw.days === currentTimeWindow.days;
  };

  return timeWindows.map(tw => ({
    description: isCurrent(tw)
      ? "(current)"
      : isPendingChangesMode(tw)
        ? "Uncommitted changes"
        : `Last ${tw.days} days`,
    picked: isCurrent(tw),
    timeWindow: tw,
    label: tw.label,
  }));
}

export function createTimeWindowQuickPick(
  timeWindows: TimeWindow[],
  currentTimeWindow: TimeWindow,
): vscode.QuickPick<TimeWindowPickItem> {
  const items = buildTimeWindowItems(timeWindows, currentTimeWindow);

  const quickPick = vscode.window.createQuickPick<TimeWindowPickItem>();
  quickPick.items = items;
  quickPick.canSelectMany = false;
  quickPick.placeholder = "Select time window for fresh files";

  return quickPick;
}
