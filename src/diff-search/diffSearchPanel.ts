import * as vscode from "vscode";
import { DiffSearchResultProvider } from "./diffSearchResultProvider";
import { DiffMatch, DiffSearchPatternError, searchHistoricalDiffs, searchPendingDiffs } from "./diffSearchParser";
import { discoverReposInWorkspace } from "../git/gitOperations";
import { AbsolutePath } from "../pathTypes";
import { log, showError, showWarning } from "../extension/logger";
import { formatGitCommand } from "../utils/formatUtils";
import { getWebviewHtml } from "../diff-search/diffSearchPanelUI";
import { DiffSearchParams, DiffSearchHistoryEntry, DiffSearchToWebview, DiffSearchFromWebview } from "../webview/messages";
import { WorkspaceStateManager } from "../extension/workspaceStateManager";
import { getLocalResourceRoots } from "../utils/webviewPanelOptions";
const MAX_HISTORY = 25;

/** The `search` request variant of the inbound message union. */
type SearchRequest = Extract<DiffSearchFromWebview, { command: "search" }>;

export class DiffSearchPanel {
  private static currentPanel: DiffSearchPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _resultProvider: DiffSearchResultProvider;
  private readonly _workspaceFolders: readonly vscode.WorkspaceFolder[];
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(
    extensionUri: vscode.Uri,
    resultProvider: DiffSearchResultProvider,
    workspaceFolders: readonly vscode.WorkspaceFolder[],
    prefillPattern?: string,
  ) {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

    // If we already have a panel, show it
    if (DiffSearchPanel.currentPanel) {
      DiffSearchPanel.currentPanel._panel.reveal(column);
      if (prefillPattern) {
        DiffSearchPanel.currentPanel._sendPrefill(prefillPattern);
      }
      return;
    }

    // Otherwise, create a new panel
    const panel = vscode.window.createWebviewPanel(
      "diffSearchPanel",
      "Diff Search",
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: getLocalResourceRoots(extensionUri),
      },
    );

    DiffSearchPanel.currentPanel = new DiffSearchPanel(panel, extensionUri, resultProvider, workspaceFolders, prefillPattern);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    resultProvider: DiffSearchResultProvider,
    workspaceFolders: readonly vscode.WorkspaceFolder[],
    private readonly _prefillPattern?: string,
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._resultProvider = resultProvider;
    this._workspaceFolders = workspaceFolders;

    // Set the webview's initial html content
    this._update();

    // Listen for when the panel is disposed
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        await this._handleMessage(message);
      },
      null,
      this._disposables,
    );
  }

  /** Typed outbound channel — every host→webview message goes through here. */
  private _post(msg: DiffSearchToWebview): void {
    void this._panel.webview.postMessage(msg);
  }

  private async _handleMessage(message: DiffSearchFromWebview) {
    switch (message.command) {
      case "search":
        await this._executeSearch(message);
        break;
      case "ready": {
        // Webview is ready, send initial data
        // Restore persisted params (overridden by prefill if present)
        const saved = WorkspaceStateManager.getDiffSearchParams();
        if (saved) {
          this._post({ command: "prefillParams", params: saved });
        }
        if (this._prefillPattern) {
          this._sendPrefill(this._prefillPattern);
        }
        // Send history
        this._sendHistory();
        break;
      }

      case "clearHistory":
        WorkspaceStateManager.setDiffSearchHistory([]);
        this._sendHistory();
        break;
    }
  }

  private _sendPrefill(pattern: string) {
    this._post({ command: "prefill", pattern });
  }

  private _sendHistory(): void {
    const entries = WorkspaceStateManager.getDiffSearchHistory();
    this._post({ command: "setHistory", entries });
  }

  private _saveParams(searchData: SearchRequest): void {
    const params: DiffSearchParams = {
      pattern: searchData.pattern,
      isRegex: searchData.isRegex,
      caseInsensitive: searchData.caseInsensitive,
      includePattern: searchData.includePattern,
      excludePattern: searchData.excludePattern,
      pendingOnly: searchData.pendingOnly,
      days: searchData.days,
    };
    WorkspaceStateManager.setDiffSearchParams(params);

    // Build human-readable label
    const flags: string[] = [];
    if (searchData.isRegex) { flags.push("regex"); }
    if (searchData.caseInsensitive) { flags.push("ci"); }
    if (searchData.pendingOnly) {
      flags.push("pending only");
    } else if (searchData.days) {
      flags.push(searchData.days + "d");
    } else {
      flags.push("all history");
    }
    if (searchData.includePattern) { flags.push("+" + searchData.includePattern); }
    if (searchData.excludePattern) { flags.push("-" + searchData.excludePattern); }
    const label = `"${searchData.pattern}"` + (flags.length ? "  ·  " + flags.join("  ·  ") : "");

    // Prepend to history, dedup by label, trim to max
    const existing = WorkspaceStateManager.getDiffSearchHistory();
    const filtered = existing.filter(e => e.label !== label);
    const updated: DiffSearchHistoryEntry[] = [
      { params, label, timestamp: Date.now() },
      ...filtered,
    ].slice(0, MAX_HISTORY);
    WorkspaceStateManager.setDiffSearchHistory(updated);
  }

  private async _executeSearch(searchData: SearchRequest) {
    this._saveParams(searchData);
    this._sendHistory();
    const { pattern, isRegex, caseInsensitive, includePattern, excludePattern, pendingOnly, days } = searchData;
    const sinceDays = days ?? -1; // null → -1 (unlimited)

    if (!pattern.trim()) {
      showWarning("Please enter a search pattern");
      return;
    }

    // Validate regex if needed
    if (isRegex) {
      try {
        new RegExp(pattern);
      } catch (error: any) {
        showError(`Invalid regex: ${error.message}`);
        return;
      }
    }

    try {
      let totalMatchCount = 0;
      let allMatches: any[] = [];

      // Execute search with commit tracking (no progress notification, only webview updates)
      const reposToSearch = this._workspaceFolders;

      const totalFolders = reposToSearch.length;

      const actualRepos = await discoverReposInWorkspace(reposToSearch, totalFolders);

      const totalRepos = actualRepos.length;
      
      // Build repo names map from actual discovered repositories
      const repoNames = new Map<AbsolutePath, string>();
      for (const repo of actualRepos) {
        log(`Adding repo to map: path="${repo.path}", name="${repo.name}"`, "info");
        repoNames.set(repo.path, repo.name);
      }
      log(`Total repos in map: ${repoNames.size}`, "info");
      log(`Searching ${totalRepos} git repositories across ${totalFolders} workspace folders`, "info");

      // Notify UI that search is starting (works for 1 or many repos)
      this._post({
        command: "reposStarted",
        repoCount: totalRepos,
        repoNames: actualRepos.map(r => r.name),
      });

      // Track state per repo
      const repoStates = new Map<string, { commits: number; matches: number; status: string }>();

      // Search all repos in parallel
      const repoPromises = actualRepos.map(async (repo, index) => {
        const repoName = repo.name;
        const repoPath = repo.path;
        const repoIndex = index + 1;

        // Initialize repo state
        repoStates.set(repoName, { commits: 0, matches: 0, status: "Searching..." });
        const repoStartTime = Date.now();

        // Send initial status
        this._post({
          command: "repoProgress",
          repoIndex: repoIndex,
          status: "Searching...",
        });

        let repoMatches: any[] = [];

        // Search historical diffs
        if (!pendingOnly) {
          const matches = await searchHistoricalDiffs(
            repoPath,
            pattern,
            isRegex,
            caseInsensitive,
            includePattern,
            excludePattern,
            sinceDays
          );
          repoMatches = repoMatches.concat(matches);
        }

        // Search pending diffs
        const pendingMatches = await searchPendingDiffs(
          repoPath,
          pattern,
          isRegex,
          caseInsensitive,
          includePattern,
          excludePattern
        );
        repoMatches = repoMatches.concat(pendingMatches);

        // Count unique commits (only for historical matches with commitHash)
        const uniqueCommits = countUniqueCommits(repoMatches);

        // Update state
        const state = repoStates.get(repoName)!;
        state.commits = uniqueCommits;
        state.matches = repoMatches.length;
        state.status = "Complete";

        // Send final results for this repo
        this._post({
          command: "repoComplete",
          repoIndex: repoIndex,
          commits: uniqueCommits,
          matches: repoMatches.length,
          pendingMatches: pendingMatches.length,
          elapsedMs: Date.now() - repoStartTime,
        });

        return repoMatches;
      });

      // Wait for all repos to complete
      const results = await Promise.allSettled(repoPromises);

      // A bad regex fails identically across every repo. Surface git's message once
      // instead of letting all repos reject and reporting a misleading "No matches".
      const patternError = results.find(
        (r): r is PromiseRejectedResult =>
          r.status === "rejected" && r.reason instanceof DiffSearchPatternError,
      );
      if (patternError) {
        const reason = (patternError.reason as DiffSearchPatternError).message;
        showError(`Invalid search pattern: ${reason}`);
        this._post({ command: "searchComplete", message: `Invalid pattern: ${reason}`, count: 0 });
        return;
      }

      // Aggregate results
      results.forEach((result) => {
        if (result.status === "fulfilled") {
          allMatches = allMatches.concat(result.value);
          totalMatchCount += result.value.length;
        }
      });

      // Now update tree view once with all results
      this._resultProvider.showResults(pattern, allMatches, repoNames);

      // Focus the diff search results view
      await vscode.commands.executeCommand("diffSearchResults.focus");

      // Report completion through the webview only — the panel's status line and
      // aggregate stats already convey the result, so no toast notification.
      if (totalMatchCount === 0) {
        this._post({
          command: "searchComplete",
          message: "No matches found",
          count: 0,
          gitCommand: buildSearchGitCommand(searchData),
        });
      } else {
        this._post({
          command: "searchComplete",
          message: `Search complete`,
          count: totalMatchCount,
          gitCommand: buildSearchGitCommand(searchData),
        });
      }
    } catch (error: any) {
      showError(`Search failed: ${error.message || error}`, `Diff search error: ${error}`);
      this._post({
        command: "searchComplete",
        message: `Error: ${error.message || error}`,
        count: 0,
      });
    }
  }

  private _update() {
    const webview = this._panel.webview;
    const scriptUri = webview
      .asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", "diffSearchPanel.js"))
      .toString();
    webview.html = getWebviewHtml(webview.cspSource, scriptUri);
  }

  public dispose() {
    DiffSearchPanel.currentPanel = undefined;

    this._panel.dispose();

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}

/**
 * Build a representative git command string from the search parameters,
 * mirroring what searchHistoricalDiffs / searchPendingDiffs actually run.
 */
function buildSearchGitCommand(search: SearchRequest): string {
  if (search.pendingOnly) {
    const args = ["diff"];
    const pathspecs = buildPathspecsForDisplay(search.includePattern, search.excludePattern);
    if (pathspecs.length > 0) {
      args.push("--", ...pathspecs);
    }
    return formatGitCommand(args);
  }

  const args: string[] = ["log", "-p"];
  if (search.caseInsensitive) {
    args.push("-i");
  }
  args.push(search.isRegex ? "-G" : "-S", search.pattern);
  if (search.days !== null && search.days > 0) {
    args.push(`--since=${search.days}.days.ago`);
  }
  const pathspecs = buildPathspecsForDisplay(search.includePattern, search.excludePattern);
  if (pathspecs.length > 0) {
    args.push("--", ...pathspecs);
  }
  return formatGitCommand(args);
}

/** Reconstruct pathspec array from include/exclude pattern strings (mirrors gitDiffSearch logic). */
function buildPathspecsForDisplay(includePattern: string, excludePattern: string): string[] {
  const specs: string[] = [];
  if (includePattern) {
    includePattern.split(",").map(p => p.trim()).filter(Boolean).forEach(p => specs.push(p));
  }
  if (excludePattern) {
    excludePattern.split(",").map(p => p.trim()).filter(Boolean).forEach(p => specs.push(`:!${p}`));
  }
  return specs;
}

/**
 * Count the number of distinct commit hashes present in a set of matches.
 * Pending matches (no commitHash) are ignored.
 */
function countUniqueCommits(matches: DiffMatch[]): number {
  const seen = new Set<string>();
  for (const match of matches) {
    if (match.commitHash) {
      seen.add(match.commitHash);
    }
  }
  return seen.size;
}
