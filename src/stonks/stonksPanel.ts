import * as vscode from "vscode";
import * as path from "path";
import { execGitWithArgs, getCommitParent, getCommitSubject, getCommitChanges, gitUri } from "../git/gitOperations";
import { buildStonksData } from "./stonksDataCollector";
import { getWebviewHtml } from "./stonksPanelUI";
import { log, showError } from "../extension/logger";
import { ConfigService } from "../config/configService";
import type { FreshFileProvider } from "../fresh-files/freshFileProvider";
import type { NormalizedRepoPath } from "../pathTypes";
import type { StonksFromWebview, StonksTimeWindowOption, StonksToWebview } from "../webview/messages";

export class StonksPanel {
  private static currentPanel: StonksPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _provider: FreshFileProvider;
  private _disposables: vscode.Disposable[] = [];
  private _selectedRepo: NormalizedRepoPath | undefined;
  private _selectedDays: number | undefined; // undefined = pending; decoupled from provider
  private _refreshTimer: ReturnType<typeof setTimeout> | undefined;

  public static createOrShow(
    extensionUri: vscode.Uri,
    provider: FreshFileProvider,
  ) {
    const column = vscode.window.activeTextEditor?.viewColumn;

    if (StonksPanel.currentPanel) {
      StonksPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "stonksPanel",
      "Code Stonks",
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );

    StonksPanel.currentPanel = new StonksPanel(panel, extensionUri, provider);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    provider: FreshFileProvider,
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._provider = provider;

    this._update();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      async (msg) => this._handleMessage(msg),
      null,
      this._disposables,
    );

    // Re-push data when the provider refreshes (time window change, git status, etc.)
    this._provider.onDidChangeTreeData(() => {
      if (!this._selectedRepo) { return; }
      clearTimeout(this._refreshTimer);
      this._refreshTimer = setTimeout(() => this._loadRepoData(this._selectedRepo!), 500);
    }, null, this._disposables);
  }

  private _postMessage(msg: StonksToWebview): void {
    this._panel.webview.postMessage(msg);
  }

  private async _handleMessage(message: StonksFromWebview) {
    switch (message.command) {
      case "ready": {
        // Send time window options (decoupled from provider's persisted selection)
        const tw = this._provider.currentTimeWindow;
        this._selectedDays = tw.type === "historical" ? tw.days : undefined;
        const options: StonksTimeWindowOption[] = this._provider.timeWindows.map(w => ({
          label: w.label,
          days: w.type === "historical" ? w.days : undefined,
        }));
        this._postMessage({ command: "setTimeWindows", options, selectedDays: this._selectedDays });

        const repos = this._provider.getRepoList();
        this._postMessage({
          command: "setRepos",
          repos: repos.map(r => ({ name: r.name, path: r.path })),
        });
        if (repos.length > 0) {
          this._selectedRepo = repos[0].path;
          this._loadRepoData(repos[0].path);
        }
        break;
      }
      case "selectRepo":
        this._selectedRepo = message.repoPath as NormalizedRepoPath;
        this._loadRepoData(this._selectedRepo);
        break;
      case "selectTimeWindow":
        this._selectedDays = message.days;
        if (this._selectedRepo) {
          this._loadRepoData(this._selectedRepo);
        }
        break;
      case "openCommit":
        if (this._selectedRepo) {
          this._openCommit(message.hash);
        }
        break;
    }
  }

  private _loadRepoData(repoPath: NormalizedRepoPath) {
    const commitStatsMap = this._provider.getCommitStats(repoPath);
    if (!commitStatsMap || commitStatsMap.size === 0) {
      log(`[Stonks] No cached commit stats for ${repoPath}`, "warn");
      this._postMessage({ command: "setData", data: [] });
      return;
    }
    this._postMessage({ command: "setLoading", loading: true });

    // Filter stats to the panel's own time window (decoupled from the provider)
    let statsArray = Array.from(commitStatsMap.values());
    if (this._selectedDays !== undefined) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - this._selectedDays);
      statsArray = statsArray.filter(s => s.commit.date >= cutoff);
    }
    if (statsArray.length === 0) {
      this._postMessage({ command: "setData", data: [] });
      this._postMessage({ command: "setLoading", loading: false });
      return;
    }

    // Baseline: count files at parent of oldest commit in range.
    const oldest = statsArray.reduce((a, b) => a.commit.date < b.commit.date ? a : b);

    execGitWithArgs(["ls-tree", "-r", "--name-only", `${oldest.commit.hash}~1`], repoPath, { timeout: ConfigService.getGitTimeoutMs() })
      .then(output => output.trim() ? output.trim().split("\n").length : 0)
      .catch(() => 0) // no parent = initial commit, baseline 0
      .then(baseline => {
        const data = buildStonksData(statsArray, baseline);
        this._postMessage({ command: "setData", data });
        this._postMessage({ command: "setLoading", loading: false });
      });
  }

  private _update() {
    const webview = this._panel.webview;
    const scriptUri = webview
      .asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", "stonksPanel.js"))
      .toString();
    webview.html = getWebviewHtml(webview.cspSource, scriptUri);
  }

  private async _openCommit(commitHash: string) {
    const repoRoot = this._selectedRepo!;
    try {
      const parentHash = await getCommitParent(repoRoot, commitHash);
      const commitSubject = await getCommitSubject(repoRoot, commitHash);
      const shortHash = commitHash.substring(0, 7);
      const title = `${shortHash} - ${commitSubject}`;

      const changes = await getCommitChanges(repoRoot, commitHash);
      if (changes.length === 0) { return; }

      const resources: { originalUri?: vscode.Uri; modifiedUri?: vscode.Uri }[] = [];
      for (const change of changes) {
        const fileUri = vscode.Uri.file(path.join(repoRoot, change.filePath));
        switch (change.status) {
          case "A":
            resources.push({ modifiedUri: gitUri(fileUri, commitHash) });
            break;
          case "D":
            resources.push({ originalUri: gitUri(fileUri, parentHash ?? commitHash) });
            break;
          case "R":
          case "C": {
            const origUri = vscode.Uri.file(path.join(repoRoot, change.originalFilePath!));
            resources.push({ originalUri: gitUri(origUri, parentHash ?? commitHash), modifiedUri: gitUri(fileUri, commitHash) });
            break;
          }
          default:
            resources.push({ originalUri: gitUri(fileUri, parentHash ?? commitHash), modifiedUri: gitUri(fileUri, commitHash) });
            break;
        }
      }

      const parentId = parentHash ?? "root";
      const multiDiffSourceUri = vscode.Uri.from({
        scheme: "scm-history-item",
        path: `${repoRoot}/${parentId}..${commitHash}`,
      });

      await vscode.commands.executeCommand("_workbench.openMultiDiffEditor", {
        multiDiffSourceUri,
        title,
        resources,
      });
    } catch (error: any) {
      showError(`Failed to open commit: ${error.message}`, `Failed to open commit ${commitHash}: ${error.message}`);
    }
  }

  public dispose() {
    StonksPanel.currentPanel = undefined;
    clearTimeout(this._refreshTimer);
    this._panel.dispose();
    while (this._disposables.length) {
      this._disposables.pop()?.dispose();
    }
  }
}
