import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execGitWithArgs, discoverReposInWorkspace } from "../git/gitOperations";
import { getWebviewHtml } from "./perfBenchmarkPanelUI";
import { Benchmark, BenchmarkInputValues } from "../benchmark/benchmark";
import { RepoInfo } from "../git/gitOperations";
import { createGitLogBenchmark, createGitLogStreamBenchmark, createGitNumstatBenchmark } from "../benchmark/gitLogBenchmark";

/**
 * Expands multi-value params (comma-separated strings) into a flat list of
 * single-value input sets, one per combination.
 * Non-multi params are passed through unchanged to every set.
 */
function expandMultiParams(inputs: BenchmarkInputValues, multiParamNames: string[]): BenchmarkInputValues[] {
  let sets: BenchmarkInputValues[] = [{ ...inputs }];
  for (const name of multiParamNames) {
    const raw = String(inputs[name] ?? "");
    const values = raw.split(",").map(s => s.trim()).filter(Boolean);
    if (values.length === 0) { continue; }
    sets = sets.flatMap(set => values.map(v => ({ ...set, [name]: isNaN(Number(v)) ? v : Number(v) })));
  }
  return sets;
}

interface RunMessage {
  command: "run";
  benchmarkName: string;
  inputs: BenchmarkInputValues;
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
  private _benchmarks: Benchmark[] = [];

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
      async (message) => { await this._handleMessage(message); },
      null,
      this._disposables,
    );

    this._initialize();
  }

  private async _initialize() {
    const repos = await discoverReposInWorkspace(this._workspaceFolders, this._workspaceFolders.length);
    this._benchmarks = [
      createGitLogBenchmark(repos),
      createGitLogStreamBenchmark(repos),
      createGitNumstatBenchmark(repos),
    ];
    this._sendBenchmarkSpecs();
  }

  private _sendBenchmarkSpecs() {
    this._panel.webview.postMessage({
      command: "benchmarks",
      benchmarks: this._benchmarks.map(b => ({ name: b.name, inputSpec: b.inputSpec, outputSpec: b.outputSpec })),
    });
  }

  private async _handleMessage(message: any) {
    if (message.command === "ready") {
      // Webview signals it is ready; re-send specs (handles reloads / first load race)
      this._sendBenchmarkSpecs();
    } else if (message.command === "run") {
      await this._runBenchmark(message as RunMessage);
    } else if (message.command === "getStats") {
      await this._sendStats();
    }
  }

  private async _runBenchmark(msg: RunMessage) {
    const benchmark = this._benchmarks.find(b => b.name === msg.benchmarkName);
    if (!benchmark) {
      this._panel.webview.postMessage({ command: "error", message: `Unknown benchmark: ${msg.benchmarkName}` });
      return;
    }
    try {
      // Expand multi-value params: run once per combination, concat all rows
      const multiParams = benchmark.inputSpec.params.filter(p => p.multi);
      const inputSets = expandMultiParams(msg.inputs, multiParams.map(p => p.name));
      const allRows = (await Promise.all(inputSets.map(inputs => benchmark.run(inputs)))).flat();
      this._panel.webview.postMessage({ command: "results", columns: benchmark.outputSpec.columns, rows: allRows });
    } catch (err: any) {
      this._panel.webview.postMessage({ command: "error", message: String(err) });
    }
  }

  private async _sendStats() {
    const repos = await discoverReposInWorkspace(this._workspaceFolders, this._workspaceFolders.length);
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
