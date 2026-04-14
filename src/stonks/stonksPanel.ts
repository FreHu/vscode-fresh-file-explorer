import * as vscode from "vscode";
import * as path from "path";
import { execGitWithArgs, getCommitParent, getCommitSubject, getCommitChanges, gitUri } from "../git/gitOperations";
import { buildStonksData } from "./stonksDataCollector";
import { getWebviewHtml } from "./stonksPanelUI";
import { log, showError } from "../extension/logger";
import { ConfigService } from "../config/configService";
import type { FreshFileProvider } from "../fresh-files/freshFileProvider";
import type { NormalizedRepoPath } from "../pathTypes";
import type { StonksFromWebview, StonksRepoSeries, StonksRepoTicker, StonksTimeWindowOption, StonksToWebview } from "../webview/messages";
import { WorkspaceStateManager } from "../extension/workspaceStateManager";

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
      "CodeStonks",
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
      this._refreshTimer = setTimeout(() => {
        this._sendRepoTickers();
        this._loadRepoData(this._selectedRepo!);
      }, 500);
    }, null, this._disposables);
  }

  private _postMessage(msg: StonksToWebview): void {
    this._panel.webview.postMessage(msg);
  }

  private _sendRepoTickers(): void {
    const repos = this._provider.getRepoList();
    const tickers: StonksRepoTicker[] = repos.map(r => {
      const ticker: StonksRepoTicker = { name: r.name, path: r.path };
      const stats = this._provider.getCommitStats(r.path);
      if (stats && stats.size > 0) {
        const arr = Array.from(stats.values());
        const latest = arr.reduce((a, b) => a.commit.date > b.commit.date ? a : b);
        ticker.lastCommitHash = latest.commit.hash.substring(0, 7);
        ticker.lastCommitMessage = latest.commit.message;
        ticker.lastCommitFilesChanged = latest.added + latest.deleted + latest.modified;
        ticker.lastCommitFilesAdded = latest.added;
        ticker.lastCommitFilesDeleted = latest.deleted;
      }
      return ticker;
    });
    this._postMessage({ command: "setRepos", repos: tickers });
  }

  private async _handleMessage(message: StonksFromWebview) {
    switch (message.command) {
      case "ready": {
        // Send persisted config first so webview can apply before rendering
        const savedConfig = WorkspaceStateManager.getStonksConfig();
        if (savedConfig) {
          this._postMessage({ command: "setConfig", config: savedConfig });
        }

        // Send time window options, excluding pending (not meaningful for stonks)
        const historicalWindows = this._provider.timeWindows.filter(
          (w): w is { type: "historical"; label: string; days: number } => w.type === "historical",
        );
        const options: StonksTimeWindowOption[] = historicalWindows.map(w => ({
          label: w.label,
          days: w.days,
        }));
        // Use persisted days if available, else derive from provider
        const tw = this._provider.currentTimeWindow;
        this._selectedDays = savedConfig?.selectedDays
          ?? (tw.type === "historical" ? tw.days : undefined)
          ?? historicalWindows[historicalWindows.length - 1]?.days
          ?? 30;
        this._postMessage({ command: "setTimeWindows", options, selectedDays: this._selectedDays });

        const repos = this._provider.getRepoList();
        this._sendRepoTickers();
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
      case "updateConfig":
        WorkspaceStateManager.setStonksConfig(message.config);
        break;
      case "requestCompareData":
        this._loadAllReposData();
        break;
      case "openHelp": {
        const docPath = vscode.Uri.joinPath(this._extensionUri, "docs", "codestonks.md");
        vscode.commands.executeCommand("markdown.showPreview", docPath);
        break;
      }
      case "exportSvg": {
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file("codestonks.svg"),
          filters: { "SVG": ["svg"] },
        });
        if (uri) {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(message.svg, "utf-8"));
          vscode.window.showInformationMessage(`Chart exported to ${path.basename(uri.fsPath)}`);
        }
        break;
      }
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

  private async _loadAllReposData() {
    const repos = this._provider.getRepoList();
    if (repos.length === 0) { return; }

    const cutoff = this._selectedDays !== undefined ? new Date() : undefined;
    if (cutoff && this._selectedDays !== undefined) { cutoff.setDate(cutoff.getDate() - this._selectedDays); }

    const series: StonksRepoSeries[] = [];
    await Promise.all(repos.map(async (repo) => {
      const commitStatsMap = this._provider.getCommitStats(repo.path);
      if (!commitStatsMap || commitStatsMap.size === 0) { return; }

      let statsArray = Array.from(commitStatsMap.values());
      if (cutoff) { statsArray = statsArray.filter(s => s.commit.date >= cutoff); }
      if (statsArray.length === 0) { return; }

      const oldest = statsArray.reduce((a, b) => a.commit.date < b.commit.date ? a : b);
      let baseline = 0;
      try {
        const output = await execGitWithArgs(["ls-tree", "-r", "--name-only", `${oldest.commit.hash}~1`], repo.path, { timeout: ConfigService.getGitTimeoutMs() });
        baseline = output.trim() ? output.trim().split("\n").length : 0;
      } catch { /* initial commit → baseline 0 */ }

      series.push({ repoName: repo.name, repoPath: repo.path, data: buildStonksData(statsArray, baseline) });
    }));

    this._postMessage({ command: "setCompareData", series });
  }

  private _update() {
    const webview = this._panel.webview;
    const scriptUri = webview
      .asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", "stonksPanel.js"))
      .toString();
    const codiconCssUri = webview
      .asWebviewUri(
        vscode.Uri.joinPath(
          this._extensionUri,
          "node_modules",
          "@vscode",
          "codicons",
          "dist",
          "codicon.css",
        ),
      )
      .toString();
    webview.html = getWebviewHtml(webview.cspSource, scriptUri, codiconCssUri);
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
