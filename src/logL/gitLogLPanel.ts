import * as vscode from "vscode";
import * as path from "path";
import { execGitWithArgs, gitUri } from "../git/gitOperations";
import { getCommitParent, getCommitChanges, getCommitSubject } from "../git/gitCommitQueries";
import { GitLogLCommit } from "../git/gitLogLParser";
import { CommitData, GitLogLToWebview, GitLogLFromWebview } from "../webview/messages";
import { getGitLogLPanelHtml } from "./gitLogLPanelUI";
import { log, showError, showInfo } from "../extension/logger";
import { normalizePath } from "../utils";
import { getLocalResourceRoots } from "../utils/webviewPanelOptions";
import { BoundedMap } from "../utils/collectionUtils";

/**
 * Manages the Git Log -L webview panel (one per unique query).
 * Receives "compare" messages from the webview and opens a VS Code diff editor
 * showing the two chosen commit versions of the file.
 */
export class GitLogLPanel {
  private static panels = new Map<string, GitLogLPanel>();

  private readonly _panel: vscode.WebviewPanel;
  private readonly _repoRoot: string;
  private readonly _filePath: string;
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
        localResourceRoots: getLocalResourceRoots(extensionUri),
      },
    );

    GitLogLPanel.panels.set(key, new GitLogLPanel(panel, extensionUri, repoRoot, filePath, lArg, label, commits, gitCommand, key, mode));
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    repoRoot: string,
    filePath: string,
    _lArg: string,
    label: string,
    commits: GitLogLCommit[],
    gitCommand: string,
    mapKey: string,
    mode: "logL" | "fileHistory" = "logL",
  ) {
    this._panel = panel;
    this._repoRoot = repoRoot;
    this._filePath = filePath;
    this._label = label;
    this._gitCommand = gitCommand;
    this._mode = mode;

    const scriptUri = panel.webview
      .asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "gitLogLPanel.js"))
      .toString();
    const codiconCssUri = panel.webview
      .asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "codicons", "codicon.css"))
      .toString();
    this._panel.webview.html = getGitLogLPanelHtml(this._panel.webview.cspSource, scriptUri, codiconCssUri);

    this._panel.onDidDispose(() => {
      GitLogLPanel.panels.delete(mapKey);
      this.dispose();
    }, null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (msg: GitLogLFromWebview) => {
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

  /** Typed outbound channel — every host→webview message goes through here. */
  private _post(msg: GitLogLToWebview): Thenable<boolean> {
    return this._panel.webview.postMessage(msg);
  }

  private _sendCommits(commits: GitLogLCommit[]) {
    this._filePathByHash.clear();
    for (const c of commits) {
      if (c.filePathAtCommit) { this._filePathByHash.set(c.hash, c.filePathAtCommit); }
    }
    const currentRelative = normalizePath(path.relative(this._repoRoot, this._filePath));
    // Commits are newest-first. For each commit, the "newer neighbour" is the
    // commit at index i-1 (or currentRelative for the first entry). Only show
    // the rename badge when the path actually changes at this boundary.
    const result = this._post({
      command: "setCommits",
      commits: commits.map((c, i): CommitData => {
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

  // `ready` is consumed by the onDidReceiveMessage handler above, so it can
  // never arrive here — excluding it lets the `never` arm below actually
  // enforce exhaustiveness over the commands this switch is responsible for.
  private async _handleMessage(msg: Exclude<GitLogLFromWebview, { command: "ready" }>) {
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
      case "openFileDiff":
        await this._openFileDiff(msg.hash);
        break;
      default: {
        const unhandled: never = msg;
        log(`GitLogLPanel: unhandled webview command: ${JSON.stringify(unhandled)}`, "warn");
      }
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
      showError(`Could not open diff: ${message}`, `git log -L diff error: ${message}`);
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
        showInfo(`No changes found in commit ${shortHash}.`);
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
      showError(`Failed to open commit: ${message}`, `git log -L open commit error: ${message}`);
    }
  }

  /**
   * Open this file's own change at `hash` as a plain diff beside the panel —
   * the commit's version against its parent's, matching the Git extension's
   * "Open Changes". Falls back to the read-only snapshot for a root commit.
   *
   * The side that doesn't exist at a boundary (the parent of an add, the child
   * of a delete) gets an empty virtual document rather than a `git:` URI for a
   * path git can't resolve — that URI opens as "file was not found", not as an
   * empty pane. Renames take their old path on the parent side.
   */
  private async _openFileDiff(hash: string) {
    try {
      const commitPath = this._filePathByHash.get(hash)
        ?? normalizePath(path.relative(this._repoRoot, this._filePath));
      const parentHash = await getCommitParent(this._repoRoot, hash);
      if (!parentHash) {
        await this._openSingle(hash);
        return;
      }

      const changes = await getCommitChanges(this._repoRoot, hash);
      const change = changes.find(c => normalizePath(c.filePath) === commitPath);
      const status = change?.status;
      const originalPath = status === "R" || status === "C"
        ? normalizePath(change!.originalFilePath!)
        : commitPath;

      const refUri = (relPath: string, ref: string) =>
        gitUri(vscode.Uri.file(path.join(this._repoRoot, relPath)), ref);
      const shortHash = hash.slice(0, 7);
      const ext = path.extname(commitPath);
      const basename = path.basename(commitPath, ext);
      const emptyUri = (side: string) =>
        this._emptyDocUri(`${basename}@${shortHash}.${side}${ext}`);

      // No entry at all means the path is untouched by this commit (possible
      // for a `-L` range whose commit only moved surrounding lines) — diff it
      // against the parent anyway rather than claiming an add.
      const original = status === "A" ? emptyUri("base") : refUri(originalPath, parentHash);
      const modified = status === "D" ? emptyUri("head") : refUri(commitPath, hash);

      const title = originalPath === commitPath
        ? `${path.basename(commitPath)} (${shortHash})`
        : `${path.basename(originalPath)} → ${path.basename(commitPath)} (${shortHash})`;
      await vscode.commands.executeCommand(
        "vscode.diff",
        original,
        modified,
        title,
        { viewColumn: vscode.ViewColumn.Beside, preview: true, preserveFocus: true },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showError(`Could not open diff: ${message}`, `git log -L file diff error: ${message}`);
    }
  }

  /** A registered, permanently empty `gitlogl://` document — the blank side of an add/delete diff. */
  private _emptyDocUri(displayName: string): vscode.Uri {
    const uri = vscode.Uri.parse(`gitlogl://empty/${displayName}`);
    GitLogLContentProvider.instance.set(uri.toString(), "");
    return uri;
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
      showError(`Could not open file: ${message}`);
    }
  }

  /**
   * Fetch the file content at a given commit and return a URI for a virtual
   * read-only document backed by a ContentProvider registered in extension.ts.
   */
  private async _getGitShowUri(hash: string, displayName: string, filePathAtCommit?: string | null): Promise<vscode.Uri> {
    const relativePath = filePathAtCommit ?? normalizePath(path.relative(this._repoRoot, this._filePath));
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

  /**
   * Bounded: entries are whole file revisions, and nothing ever removed them,
   * so a long session browsing history grew this without limit. Evicting on
   * document close instead would blank the content when VS Code re-queries a
   * reopened diff, so keep the recent ones and drop the coldest.
   */
  private _store = new BoundedMap<string, string>(50);

  set(uri: string, content: string) {
    this._store.set(uri, content);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this._store.get(uri.toString()) ?? "";
  }
}