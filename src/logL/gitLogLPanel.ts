import * as vscode from "vscode";
import * as path from "path";
import { execGitWithArgs, gitUri, getCommitParent, getCommitChanges, getCommitSubject } from "../git/gitOperations";
import { GitLogLCommit } from "../git/gitLogLParser";
import { getGitLogLPanelHtml } from "./gitLogLPanelUI";
import { log } from "../extension/logger";

/**
 * Manages the Git Log -L webview panel (one per unique query).
 * Receives "compare" messages from the webview and opens a VS Code diff editor
 * showing the two chosen commit versions of the file.
 */
export class GitLogLPanel {
  private static panels = new Map<string, GitLogLPanel>();

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _repoRoot: string;
  private readonly _filePath: string;
  private readonly _lArg: string;
  private readonly _label: string;
  private readonly _gitCommand: string;
  private readonly _mode: "logL" | "fileHistory";
  private _disposables: vscode.Disposable[] = [];
  /** Maps commit hash to the file path as it existed at that commit (handles renames). */
  private _filePathByHash = new Map<string, string>();

  public static createOrShow(
    extensionUri: vscode.Uri,
    repoRoot: string,
    filePath: string,
    lArg: string,
    label: string,
    commits: GitLogLCommit[],
    gitCommand: string,
    mode: "logL" | "fileHistory" = "logL",
  ) {
    const key = `${filePath}|${lArg}`;
    const existing = GitLogLPanel.panels.get(key);
    if (existing) {
      existing._panel.reveal();
      existing._sendCommits(commits);
      return;
    }

    const tabTitle = mode === "fileHistory" ? `History: ${label}` : `Log -L: ${label}`;
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    const panel = vscode.window.createWebviewPanel(
      "gitLogLPanel",
      tabTitle,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );

    GitLogLPanel.panels.set(key, new GitLogLPanel(panel, extensionUri, repoRoot, filePath, lArg, label, commits, gitCommand, key, mode));
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    repoRoot: string,
    filePath: string,
    lArg: string,
    label: string,
    commits: GitLogLCommit[],
    gitCommand: string,
    mapKey: string,
    mode: "logL" | "fileHistory" = "logL",
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._repoRoot = repoRoot;
    this._filePath = filePath;
    this._lArg = lArg;
    this._label = label;
    this._gitCommand = gitCommand;
    this._mode = mode;

    const scriptUri = panel.webview
      .asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "gitLogLPanel.js"))
      .toString();
    this._panel.webview.html = getGitLogLPanelHtml(this._panel.webview.cspSource, scriptUri);

    this._panel.onDidDispose(() => {
      GitLogLPanel.panels.delete(mapKey);
      this.dispose();
    }, null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (msg) => {
        if (msg.command === "ready") {
          this._sendCommits(commits);
        } else {
          await this._handleMessage(msg);
        }
      },
      null,
      this._disposables,
    );
  }

  private _sendCommits(commits: GitLogLCommit[]) {
    this._filePathByHash.clear();
    for (const c of commits) {
      if (c.filePathAtCommit) { this._filePathByHash.set(c.hash, c.filePathAtCommit); }
    }
    const currentRelative = toForwardSlashes(path.relative(this._repoRoot, this._filePath));
    // Commits are newest-first. For each commit, the "newer neighbour" is the
    // commit at index i-1 (or currentRelative for the first entry). Only show
    // the rename badge when the path actually changes at this boundary.
    const result = this._panel.webview.postMessage({
      command: "setCommits",
      commits: commits.map((c, i) => {
        const newerPath = i === 0 ? currentRelative : (commits[i - 1].filePathAtCommit ?? currentRelative);
        const thisPath = c.filePathAtCommit ?? currentRelative;
        return {
          hash: c.hash,
          shortHash: c.shortHash,
          author: c.author,
          date: c.date.toISOString(),
          message: c.message,
          hunk: c.hunk,
          added: c.added,
          removed: c.removed,
          filePathAtCommit: thisPath !== newerPath ? thisPath : null,
        };
      }),
      label: this._label,
      gitCommand: this._gitCommand,
      mode: this._mode,
    });
    result.then(
      ok => log(`GitLogLPanel: postMessage resolved: ${ok}`, "info"),
      err => log(`GitLogLPanel: postMessage rejected: ${err}`, "error"),
    );
  }

  private async _handleMessage(msg: any) {
    switch (msg.command) {
      case "compare":
        await this._openDiff(msg.hashA, msg.hashB);
        break;
      case "openSingle":
        await this._openSingle(msg.hash);
        break;
      case "openCommit":
        await this._openCommit(msg.hash);
        break;
    }
  }

  private async _openDiff(hashA: string, hashB: string) {
    try {
      const pathA = this._filePathByHash.get(hashA) ?? null;
      const pathB = this._filePathByHash.get(hashB) ?? null;
      // Use the per-commit path for display name so the extension reflects the actual file type
      const extA = path.extname(pathA ?? this._filePath);
      const extB = path.extname(pathB ?? this._filePath);
      const basenameA = path.basename((pathA ?? this._filePath), extA);
      const basenameB = path.basename((pathB ?? this._filePath), extB);

      const uriA = await this._getGitShowUri(hashA, `${basenameA}@${hashA.slice(0, 8)}${extA}`, pathA);
      const uriB = await this._getGitShowUri(hashB, `${basenameB}@${hashB.slice(0, 8)}${extB}`, pathB);

      const title = `${hashA.slice(0, 8)} ↔ ${hashB.slice(0, 8)}: ${path.basename(this._filePath)}`;
      await vscode.commands.executeCommand("vscode.diff", uriA, uriB, title);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`git log -L diff error: ${message}`, "error");
      vscode.window.showErrorMessage(`Could not open diff: ${message}`);
    }
  }

  private async _openCommit(hash: string) {
    try {
      const parentHash = await getCommitParent(this._repoRoot, hash);
      const commitSubject = await getCommitSubject(this._repoRoot, hash);
      const shortHash = hash.slice(0, 7);
      const title = `${shortHash} - ${commitSubject}`;

      const changes = await getCommitChanges(this._repoRoot, hash);
      if (changes.length === 0) {
        vscode.window.showInformationMessage(`No changes found in commit ${shortHash}.`);
        return;
      }

      const resources: { originalUri?: vscode.Uri; modifiedUri?: vscode.Uri }[] = [];
      for (const change of changes) {
        const fileUri = vscode.Uri.file(path.join(this._repoRoot, change.filePath));
        switch (change.status) {
          case "A":
            resources.push({ originalUri: undefined, modifiedUri: gitUri(fileUri, hash) });
            break;
          case "D":
            resources.push({ originalUri: gitUri(fileUri, parentHash ?? hash), modifiedUri: undefined });
            break;
          case "R":
          case "C": {
            const origUri = vscode.Uri.file(path.join(this._repoRoot, change.originalFilePath!));
            resources.push({ originalUri: gitUri(origUri, parentHash ?? hash), modifiedUri: gitUri(fileUri, hash) });
            break;
          }
          default:
            resources.push({ originalUri: gitUri(fileUri, parentHash ?? hash), modifiedUri: gitUri(fileUri, hash) });
            break;
        }
      }

      const parentId = parentHash ?? "root";
      const multiDiffSourceUri = vscode.Uri.from({
        scheme: "scm-history-item",
        path: `${this._repoRoot}/${parentId}..${hash}`,
      });

      await vscode.commands.executeCommand("_workbench.openMultiDiffEditor", {
        multiDiffSourceUri,
        title,
        resources,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`git log -L open commit error: ${message}`, "error");
      vscode.window.showErrorMessage(`Failed to open commit: ${message}`);
    }
  }

  private async _openSingle(hash: string) {
    try {
      const commitPath = this._filePathByHash.get(hash) ?? null;
      const ext = path.extname(commitPath ?? this._filePath);
      const basename = path.basename(commitPath ?? this._filePath, ext);
      const uri = await this._getGitShowUri(hash, `${basename}@${hash.slice(0, 8)}${ext}`, commitPath);
      await vscode.window.showTextDocument(uri, { preview: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Could not open file: ${message}`);
    }
  }

  /**
   * Fetch the file content at a given commit and return a URI for a virtual
   * read-only document backed by a ContentProvider registered in extension.ts.
   */
  private async _getGitShowUri(hash: string, displayName: string, filePathAtCommit?: string | null): Promise<vscode.Uri> {
    const relativePath = filePathAtCommit ?? toForwardSlashes(path.relative(this._repoRoot, this._filePath));
    const content = await execGitWithArgs(
      ["show", `${hash}:${relativePath}`],
      this._repoRoot,
      { timeout: 10000 },
    );

    // Store content in the shared registry, addressable by a uri
    const uri = vscode.Uri.parse(`gitlogl://${hash}/${displayName}`);
    GitLogLContentProvider.instance.set(uri.toString(), content);
    return uri;
  }

  public dispose() {
    this._panel.dispose();
    while (this._disposables.length) {
      this._disposables.pop()?.dispose();
    }
  }
}

/**
 * Simple in-memory content provider for `gitlogl://` URIs.
 * Content is populated just before `vscode.diff` is called.
 */
export class GitLogLContentProvider implements vscode.TextDocumentContentProvider {
  public static readonly scheme = "gitlogl";
  public static instance = new GitLogLContentProvider();

  private _store = new Map<string, string>();

  set(uri: string, content: string) {
    this._store.set(uri, content);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this._store.get(uri.toString()) ?? "";
  }
}

function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}
