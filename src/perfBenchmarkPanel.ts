import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execGitWithArgs, isGitRepository, discoverGitReposInSubdirs } from "./git/gitOperations";
import { AbsolutePath, asAbsolutePath } from "./pathTypes";
import { log } from "./utils/logger";
import { getWebviewHtml } from "./perfBenchmarkPanelUI";

interface RepoInfo {
  name: string;
  path: AbsolutePath;
}

interface RunMessage {
  command: "run";
  ranges: number[];
  mode: "log" | "numstat" | "both";
  pathspec: string;
}

interface BenchmarkResult {
  days: number;
  mode: "log" | "numstat";
  repoLabel: string;
  elapsedMs: number;
  lines: number;
  bytes: number;
  error?: string;
}

interface RepoStats {
  repoLabel: string;
  repoPath: string;
  commitCount: number | null;
  oldestCommitDate: string | null;
  authorCount: number | null;
  currentBranch: string | null;
  hasCommitGraph: boolean;
  commitGraphPath: string;
  error?: string;
}

export class PerfBenchmarkPanel {
  private static currentPanel: PerfBenchmarkPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _workspaceFolders: readonly vscode.WorkspaceFolder[];
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri, workspaceFolders: readonly vscode.WorkspaceFolder[]) {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (PerfBenchmarkPanel.currentPanel) {
      PerfBenchmarkPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "perfBenchmarkPanel",
      "Git Perf Benchmark",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );

    PerfBenchmarkPanel.currentPanel = new PerfBenchmarkPanel(panel, extensionUri, workspaceFolders);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    workspaceFolders: readonly vscode.WorkspaceFolder[],
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._workspaceFolders = workspaceFolders;

    this._panel.webview.html = this._getHtml();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        await this._handleMessage(message);
      },
      null,
      this._disposables,
    );
  }

  private async _handleMessage(message: any) {
    if (message.command === "run") {
      await this._runBenchmark(message as RunMessage);
    } else if (message.command === "getStats") {
      await this._sendStats();
    }
  }

  private async _sendStats() {
    const repos = await this._collectRepos();
    if (repos.length === 0) {
      this._panel.webview.postMessage({ command: "statsError", message: "No Git repositories found in workspace." });
      return;
    }
    const stats = await Promise.all(repos.map(r => this._getRepoStats(r)));
    this._panel.webview.postMessage({ command: "stats", stats });
  }

  private async _getRepoStats(repo: RepoInfo): Promise<RepoStats> {
    const gitDir = path.join(repo.path, ".git");
    const singleGraphPath = path.join(gitDir, "objects", "info", "commit-graph");
    const chainGraphPath  = path.join(gitDir, "objects", "info", "commit-graphs", "chain");
    const hasCommitGraph  = fs.existsSync(singleGraphPath) || fs.existsSync(chainGraphPath);
    const commitGraphPath = fs.existsSync(chainGraphPath) ? chainGraphPath : singleGraphPath;

    try {
      const [countOut, rootOut, shortlogOut, branchOut] = await Promise.all([
        execGitWithArgs(["rev-list", "--count", "HEAD"], repo.path).catch(() => ""),
        execGitWithArgs(["rev-list", "--max-parents=0", "HEAD"], repo.path).catch(() => ""),
        execGitWithArgs(["shortlog", "-s", "--all"], repo.path).catch(() => ""),
        execGitWithArgs(["branch", "--show-current"], repo.path).catch(() => ""),
      ]);

      const commitCount = countOut.trim() ? parseInt(countOut.trim(), 10) : null;
      const authorCount = shortlogOut.trim() ? shortlogOut.trim().split("\n").length : null;
      const currentBranch = branchOut.trim() || null;

      // Get date of the root (oldest) commit
      let oldestCommitDate: string | null = null;
      const rootHash = rootOut.trim().split("\n")[0];
      if (rootHash) {
        const dateOut = await execGitWithArgs(["log", "-1", "--format=%aI", rootHash], repo.path).catch(() => "");
        oldestCommitDate = dateOut.trim() || null;
      }

      return { repoLabel: repo.name, repoPath: repo.path, commitCount, oldestCommitDate, authorCount, currentBranch, hasCommitGraph, commitGraphPath };
    } catch (err: any) {
      return { repoLabel: repo.name, repoPath: repo.path, commitCount: null, oldestCommitDate: null, authorCount: null, currentBranch: null, hasCommitGraph, commitGraphPath, error: String(err) };
    }
  }

  private async _runBenchmark(msg: RunMessage) {
    const repos = await this._collectRepos();
    if (repos.length === 0) {
      this._panel.webview.postMessage({ command: "error", message: "No Git repositories found in workspace." });
      return;
    }

    const modes = msg.mode === "both" ? ["log", "numstat"] as const : [msg.mode];
    const results: BenchmarkResult[] = [];

    // Outermost loop = mode so all log rows appear before all numstat rows
    for (const mode of modes) {
      for (const days of msg.ranges) {
        for (const repo of repos) {
          const result = await this._runSingle(days, mode, repo, msg.pathspec);
          results.push(result);
        }
      }
    }

    this._panel.webview.postMessage({ command: "results", results });
  }

  private async _runSingle(days: number, mode: "log" | "numstat", repo: RepoInfo, pathspec: string): Promise<BenchmarkResult> {
    const since = `${days}.days.ago`;
    const modeFlag = mode === "log" ? "--name-status" : "--numstat";
    const args = [
      "log",
      `--since=${since}`,
      modeFlag,
      `--pretty=format:__COMMIT__%h|%an|%aI|%s`,
      ...(pathspec ? ["--", pathspec] : []),
    ];

    log(`[perf-benchmark] git ${args.join(" ")} in ${repo.name}`);
    const start = Date.now();
    try {
      const output = await execGitWithArgs(args, repo.path);
      const elapsedMs = Date.now() - start;
      const bytes = Buffer.byteLength(output, "utf8");
      const lines = output ? output.split("\n").length : 0;
      return { days, mode, repoLabel: repo.name, elapsedMs, lines, bytes };
    } catch (err: any) {
      const elapsedMs = Date.now() - start;
      return { days, mode, repoLabel: repo.name, elapsedMs, lines: 0, bytes: 0, error: String(err) };
    }
  }

  private async _collectRepos(): Promise<RepoInfo[]> {
    const repos: RepoInfo[] = [];
    const totalFolders = this._workspaceFolders.length;

    for (const folder of this._workspaceFolders) {
      const folderPath = folder.uri.fsPath;
      const rootIsGit = await isGitRepository(folderPath);

      if (rootIsGit) {
        repos.push({ name: totalFolders > 1 ? folder.name : folder.name, path: asAbsolutePath(folderPath) });
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

  private _getHtml(): string {
    const webview = this._panel.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "perfBenchmarkPanel.js"),
    ).toString();
    return getWebviewHtml(webview.cspSource, scriptUri);
  }

  public dispose() {
    PerfBenchmarkPanel.currentPanel = undefined;
    this._panel.dispose();
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables = [];
  }
}
