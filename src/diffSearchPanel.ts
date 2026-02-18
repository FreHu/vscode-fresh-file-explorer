import * as vscode from "vscode";
import { DiffSearchResultProvider } from "./diffSearchResultProvider";
import { DiffMatch, searchHistoricalDiffs, searchPendingDiffs } from "./git/gitDiffSearch";
import { isGitRepository, discoverGitReposInSubdirs } from "./git/gitOperations";
import { AbsolutePath, asAbsolutePath } from "./pathTypes";
import { log } from "./utils/logger";
import { getWebviewHtml } from "./diffSearchPanelUI";

interface SearchMessage {
  command: "search";
  pattern: string;
  isRegex: boolean;
  caseInsensitive: boolean;
  includePattern: string;
  excludePattern: string;
  pendingOnly: boolean;
  days: number | null; // null = unlimited (all history)
  selectedRepos: string[]; // Empty array means all repos
}

interface WorkspaceRepo {
  path: AbsolutePath;
  name: string;
}

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
  ) {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

    // If we already have a panel, show it
    if (DiffSearchPanel.currentPanel) {
      DiffSearchPanel.currentPanel._panel.reveal(column);
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
        localResourceRoots: [extensionUri],
      },
    );

    DiffSearchPanel.currentPanel = new DiffSearchPanel(panel, extensionUri, resultProvider, workspaceFolders);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    resultProvider: DiffSearchResultProvider,
    workspaceFolders: readonly vscode.WorkspaceFolder[],
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

  private async _handleMessage(message: any) {
    switch (message.command) {
      case "search":
        await this._executeSearch(message as SearchMessage);
        break;
      case "ready":
        // Webview is ready, send initial data
        await this._sendRepoList();
        break;
    }
  }

  private async _sendRepoList() {
    const repos: WorkspaceRepo[] = [];

    for (const folder of this._workspaceFolders) {
      repos.push({
        path: asAbsolutePath(folder.uri.fsPath),
        name: folder.name,
      });
    }

    this._panel.webview.postMessage({
      command: "setRepos",
      repos: repos,
    });
  }

  private async _executeSearch(searchData: SearchMessage) {
    const { pattern, isRegex, caseInsensitive, includePattern, excludePattern, pendingOnly, days, selectedRepos } = searchData;
    const sinceDays = days ?? -1; // null → -1 (unlimited)

    if (!pattern.trim()) {
      vscode.window.showWarningMessage("Please enter a search pattern");
      return;
    }

    // Validate regex if needed
    if (isRegex) {
      try {
        new RegExp(pattern);
      } catch (error: any) {
        vscode.window.showErrorMessage(`Invalid regex: ${error.message}`);
        return;
      }
    }

    try {
      let totalMatchCount = 0;
      let allMatches: any[] = [];

      // Execute search with commit tracking (no progress notification, only webview updates)
      const reposToSearch =
        selectedRepos.length > 0
          ? this._workspaceFolders.filter((f) => selectedRepos.includes(asAbsolutePath(f.uri.fsPath)))
          : this._workspaceFolders;

      const totalFolders = reposToSearch.length;

      const actualRepos = await expandWorkspaceFoldersToRepos(reposToSearch, totalFolders);

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
      this._panel.webview.postMessage({
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
        this._panel.webview.postMessage({
          command: "repoProgress",
          repoIndex: repoIndex,
          repoName: repoName,
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
        this._panel.webview.postMessage({
          command: "repoComplete",
          repoIndex: repoIndex,
          repoName: repoName,
          commits: uniqueCommits,
          matches: repoMatches.length,
          elapsedMs: Date.now() - repoStartTime,
        });

        return repoMatches;
      });

      // Wait for all repos to complete
      const results = await Promise.allSettled(repoPromises);

      // Aggregate results
      results.forEach((result, i) => {
        const repoName = actualRepos[i].name;
        if (result.status === "fulfilled") {
          log(`Repo ${repoName} completed with ${result.value.length} matches`, "info");
          allMatches = allMatches.concat(result.value);
          totalMatchCount += result.value.length;
        } else {
          log(`Repo ${repoName} failed: ${result.reason}`, "error");
        }
      });

      log(`Search complete: ${totalMatchCount} total matches from ${results.filter(r => r.status === "fulfilled").length}/${results.length} repos`, "info");

      // Now update tree view once with all results
      this._resultProvider.showResults(pattern, allMatches, repoNames);

      // Focus the diff search results view
      await vscode.commands.executeCommand("diffSearchResults.focus");

      // Send final status back to webview and show notification
      if (totalMatchCount === 0) {
        this._panel.webview.postMessage({
          command: "searchComplete",
          message: "No matches found",
          count: 0,
        });
        vscode.window.showInformationMessage(`Diff search complete: No matches found for "${pattern}"`);
      } else {
        this._panel.webview.postMessage({
          command: "searchComplete",
          message: `Search complete`,
          count: totalMatchCount,
        });
        
        // Count unique commits for notification
        const uniqueCommits = countUniqueCommits(allMatches);
        
        if (uniqueCommits > 0) {
          vscode.window.showInformationMessage(`Diff search complete: Found ${totalMatchCount} matches in ${uniqueCommits} commits`);
        } else {
          vscode.window.showInformationMessage(`Diff search complete: Found ${totalMatchCount} matches in pending changes`);
        }
      }
    } catch (error: any) {
      log(`Diff search error: ${error}`, "error");
      vscode.window.showErrorMessage(`Search failed: ${error.message || error}`);
      this._panel.webview.postMessage({
        command: "searchComplete",
        message: `Error: ${error.message || error}`,
        count: 0,
      });
    }
  }

  private _update() {
    const webview = this._panel.webview;
    this._panel.webview.html = getWebviewHtml(webview.cspSource);
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

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

interface RepoInfo {
  name: string;
  path: AbsolutePath;
}

/**
 * Expand a list of workspace folders into the actual git repositories they
 * contain. If the folder root itself is a git repo it is used directly;
 * otherwise immediate subdirectories are scanned.
 */
async function expandWorkspaceFoldersToRepos(
  folders: readonly vscode.WorkspaceFolder[],
  totalFolders: number,
): Promise<RepoInfo[]> {
  const repos: RepoInfo[] = [];

  for (const folder of folders) {
    const folderPath = folder.uri.fsPath;
    const rootIsGit = await isGitRepository(folderPath);

    if (rootIsGit) {
      repos.push({ name: folder.name, path: asAbsolutePath(folderPath) });
    } else {
      const subRepos = await discoverGitReposInSubdirs(folderPath);
      for (const repoRelPath of subRepos) {
        const repoFullPath = asAbsolutePath(`${folderPath}/${repoRelPath}`);
        const repoName = totalFolders > 1 ? `${folder.name}/${repoRelPath}` : repoRelPath;
        repos.push({ name: repoName, path: repoFullPath });
      }
    }
  }

  return repos;
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
