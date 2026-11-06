import * as vscode from "vscode";
import * as path from "path";
import { execGitWithArgs } from "../git/gitOperations";
import { openCommitByHash } from "../commands/openCommitCommand";
import { buildStonksData, commitsInWindow } from "./stonksDataCollector";
import { getWebviewHtml } from "./stonksPanelUI";
import { log } from "../extension/logger";
import { ConfigService } from "../config/configService";
import type { FreshFileProvider } from "../fresh-files/freshFileProvider";
import type { NormalizedRepoPath } from "../pathTypes";
import type { StonksDataPoint, StonksFromWebview, StonksRepoSeries, StonksRepoTicker, StonksTimeWindowOption, StonksToWebview } from "../webview/messages";
import { WorkspaceStateManager } from "../extension/workspaceStateManager";
import { getLocalResourceRoots } from "../utils/webviewPanelOptions";

export class StonksPanel {
  private static currentPanel: StonksPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _provider: FreshFileProvider;
  private _disposables: vscode.Disposable[] = [];
  private _selectedRepo: NormalizedRepoPath | undefined;
  private _selectedDays: number | undefined; // undefined = pending; decoupled from provider
  private _refreshTimer: ReturnType<typeof setTimeout> | undefined;
  // False until the webview's "ready" handshake has configured the panel
  // (time window, persisted config). Data must not be pushed before that:
  // an undefined _selectedDays would chart the entire history unfiltered.
  private _webviewReady = false;

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
        enableFindWidget: true,
        localResourceRoots: getLocalResourceRoots(extensionUri),
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

    // Re-push data when the provider refreshes (time window change, git status, etc.).
    // Also covers the panel opening before any history exists — the repo list arrives
    // with discovery and the stats with the load, so re-bootstrap rather than bail on
    // a still-unset selection.
    this._provider.onDidChangeTreeData(() => {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = setTimeout(() => {
        if (!this._webviewReady) { return; } // "ready" pushes the initial state itself
        this._bootstrapRepos();
        if (this._selectedRepo) {
          this._loadRepoData(this._selectedRepo);
        }
      }, 500);
    }, null, this._disposables);
  }

  private _post(msg: StonksToWebview): void {
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
    this._post({ command: "setRepos", repos: tickers, selectedPath: this._selectedRepo });
  }

  /** Sync the selection to the current repo list, then push the tickers (which carry it). */
  private _bootstrapRepos(): void {
    const repos = this._provider.getRepoList();
    // Covers both first bootstrap (nothing selected) and a selected repo that
    // vanished from the workspace (hard refresh after a folder change).
    if (!this._selectedRepo || !repos.some(r => r.path === this._selectedRepo)) {
      this._selectedRepo = repos[0]?.path;
    }
    this._sendRepoTickers();
  }

  private async _handleMessage(message: StonksFromWebview) {
    switch (message.command) {
      case "ready": {
        this._webviewReady = true;
        // Send persisted config first so webview can apply before rendering
        const savedConfig = WorkspaceStateManager.getStonksConfig();
        if (savedConfig) {
          this._post({ command: "setConfig", config: savedConfig });
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
        this._post({ command: "setTimeWindows", options, selectedDays: this._selectedDays });

        // Commit stats only exist after a scan. Opening this panel is an explicit
        // request for them, so load rather than render empty tickers; the
        // onDidChangeTreeData handler pushes the data once it lands.
        void this._provider.ensureDataLoaded();

        this._bootstrapRepos();
        if (this._selectedRepo) {
          this._loadRepoData(this._selectedRepo);
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
          void openCommitByHash(message.hash, this._selectedRepo);
        }
        break;
      case "updateConfig":
        WorkspaceStateManager.setStonksConfig(message.config);
        break;
      case "requestCompareData":
        void this._loadAllReposData();
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
      this._post({ command: "setData", data: [] });
      return;
    }
    this._post({ command: "setLoading", loading: true });

    // The panel's own time window, decoupled from the provider's.
    const range = commitsInWindow(commitStatsMap.values(), this._selectedDays);
    if (!range) {
      this._post({ command: "setData", data: [] });
      this._post({ command: "setLoading", loading: false });
      return;
    }

    void StonksPanel._seriesData(repoPath, range).then(data => {
      this._post({ command: "setData", data });
      this._post({ command: "setLoading", loading: false });
    });
  }

  /** Chart data on top of the file count at the parent of the window's oldest commit. */
  private static async _seriesData(
    repoPath: string,
    range: NonNullable<ReturnType<typeof commitsInWindow>>,
  ): Promise<StonksDataPoint[]> {
    let baseline = 0;
    try {
      const output = await execGitWithArgs(["ls-tree", "-r", "--name-only", `${range.oldest.commit.hash}~1`], repoPath, { timeout: ConfigService.getGitTimeoutMs() });
      baseline = output.trim() ? output.trim().split("\n").length : 0;
    } catch { /* no parent = initial commit, baseline 0 */ }
    return buildStonksData(range.stats, baseline);
  }

  private async _loadAllReposData() {
    const repos = this._provider.getRepoList();
    if (repos.length === 0) { return; }

    const series: StonksRepoSeries[] = [];
    await Promise.all(repos.map(async (repo) => {
      const commitStatsMap = this._provider.getCommitStats(repo.path);
      if (!commitStatsMap || commitStatsMap.size === 0) { return; }

      const range = commitsInWindow(commitStatsMap.values(), this._selectedDays);
      if (!range) { return; }

      series.push({ repoName: repo.name, repoPath: repo.path, data: await StonksPanel._seriesData(repo.path, range) });
    }));

    this._post({ command: "setCompareData", series });
  }

  private _update() {
    const webview = this._panel.webview;
    const scriptUri = webview
      .asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", "stonksPanel.js"))
      .toString();
    const codiconCssUri = webview
      .asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", "codicons", "codicon.css"))
      .toString();
    webview.html = getWebviewHtml(webview.cspSource, scriptUri, codiconCssUri);
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
