import * as vscode from "vscode";
import * as path from "path";

import { SavedComparisonsService } from "./savedComparisonsService";
import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { getAvailableBranches, execGitWithArgs } from "../git/gitOperations";
import { ConfigService } from "../config/configService";
import { log } from "../extension/logger";
import { normalizePath } from "../utils";
import { getLocalResourceRoots } from "../utils/webviewPanelOptions";
import { NormalizedRepoPath } from "../pathTypes";
import { getBranchCompareSettingsHtml } from "./branchCompareSettingsPanelUI";
import {
  BranchCompareSettingsFromWebview,
  HeatmapSettingsDTO,
  RefValidationResult,
  RepoDTO,
  SavedComparisonDTO,
} from "../webview/messages";
import { WorkspaceStateManager } from "../extension/workspaceStateManager";

/**
 * Webview panel for managing the saved branch comparisons. Singleton — calling
 * `createOrShow` on an existing panel reveals it instead of creating a new one.
 *
 * Responsibilities:
 *  - Render the table UI (HTML/CSS via `getBranchCompareSettingsHtml`)
 *  - Receive command messages from the webview, dispatch to the service
 *  - Push state back to the webview whenever the service fires onDidChange
 *  - Resolve ref autocompletes by calling `getAvailableBranches` on demand
 */
export class BranchCompareSettingsPanel {
  private static instance: BranchCompareSettingsPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];
  /** Per-repo branch-list cache so repeated picker openings don't re-spawn git for-each-ref. */
  private readonly _refsCache = new Map<NormalizedRepoPath, Promise<{ name: string; relativeDate: string }[]>>();

  static createOrShow(
    extensionUri: vscode.Uri,
    service: SavedComparisonsService,
    freshFileProvider: FreshFileProvider,
  ): void {
    const existing = BranchCompareSettingsPanel.instance;
    if (existing) {
      existing._panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "freshFileExplorer.branchCompareSettings",
      "Branch Comparisons",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: getLocalResourceRoots(extensionUri),
      },
    );
    BranchCompareSettingsPanel.instance = new BranchCompareSettingsPanel(
      panel, extensionUri, service, freshFileProvider,
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly service: SavedComparisonsService,
    private readonly freshFileProvider: FreshFileProvider,
  ) {
    this._panel = panel;

    const scriptUri = panel.webview
      .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "branchCompareSettings.js"))
      .toString();
    const codiconCssUri = panel.webview
      .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "codicons", "codicon.css"))
      .toString();
    this._panel.webview.html = getBranchCompareSettingsHtml(
      this._panel.webview.cspSource,
      scriptUri,
      codiconCssUri,
    );

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (msg: BranchCompareSettingsFromWebview) => this._handleMessage(msg),
      null,
      this._disposables,
    );

    // Push fresh state on any service change so the table stays in sync with
    // tree-side mutations (toggle-active from the tree, blame-heatmap baseline
    // changes, etc.).
    this._disposables.push(
      this.service.onDidChange(() => this._pushState()),
    );

    // FreshFileProvider's branch info populates async — re-push state when
    // it lands so the "current branch" hint in the source-ref dropdown is right.
    this._disposables.push(
      this.freshFileProvider.onDidChangeTreeData(() => this._pushState()),
    );

    // Heatmap toggles + auto-apply live in user-config. The mode lives in
    // workspace state, which has no event — but it only changes via this panel
    // or via the editor's right-click picker, and either path runs through us
    // or fires a config event indirectly. A periodic re-push on config change
    // catches the common case; the rare stale-mode case clears on panel reveal.
    this._disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (
          e.affectsConfiguration("freshFileExplorer.heatmap") ||
          e.affectsConfiguration("freshFileExplorer.blameHeatmap")
        ) {
          this._pushHeatmapState();
        }
      }),
    );
  }

  dispose(): void {
    BranchCompareSettingsPanel.instance = undefined;
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) { try { d.dispose(); } catch { /* swallow */ } }
    }
    try { this._panel.dispose(); } catch { /* may already be disposed */ }
  }

  private async _handleMessage(msg: BranchCompareSettingsFromWebview): Promise<void> {
    switch (msg.command) {
      case "ready":
        this._pushState();
        this._pushHeatmapState();
        break;
      case "add":
        this.service.add({
          repoFullPath: msg.repoFullPath,
          source: msg.source,
          target: msg.target,
          label: msg.label,
        });
        break;
      case "update":
        // The DTO's `repoFullPath` is a plain string; the service expects a
        // branded NormalizedRepoPath but does the asNormalizedRepoPath cast
        // itself. Drop in via a structural assertion to satisfy the type.
        this.service.update(msg.id, msg.patch as Parameters<typeof this.service.update>[1]);
        break;
      case "delete":
        this.service.delete(msg.id);
        break;
      case "move":
        this.service.move(msg.id, msg.delta);
        break;
      case "moveTo":
        this.service.moveTo(msg.id, msg.targetIndex);
        break;
      case "setHeatmapBaseline":
        this.service.setHeatmapBaseline(msg.id);
        break;
      case "setAllGroupingMode":
        this.service.setAllGroupingModes(msg.mode);
        break;
      case "requestRefs":
        await this._sendRefs(msg.repoFullPath);
        break;
      case "validateRef":
        await this._sendValidation(msg.repoFullPath, msg.ref);
        break;
      case "refreshRefs":
        this._refsCache.clear();
        this._validationCache.clear();
        break;
      case "updateHeatmap":
        if (msg.patch.enabled !== undefined) {
          await ConfigService.setHeatmapEnabled(msg.patch.enabled);
        }
        if (msg.patch.autoApply !== undefined) {
          await ConfigService.setBlameHeatmapAutoApply(msg.patch.autoApply);
        }
        if (msg.patch.mode !== undefined) {
          WorkspaceStateManager.setBlameHeatmapMode(msg.patch.mode);
          // Mode is workspace-state — onDidChangeConfiguration won't fire for
          // it. Push the fresh state so the panel stays in sync.
          this._pushHeatmapState();
        }
        break;
      case "openHeatmapHelp": {
        const docUri = vscode.Uri.joinPath(this.extensionUri, "docs", "heatmap.md");
        void vscode.commands.executeCommand("markdown.showPreview", docUri);
        break;
      }
      default: {
        const _exhaustive: never = msg;
        log(`branchCompareSettings: unknown message ${JSON.stringify(_exhaustive)}`, "warn");
      }
    }
  }

  /**
   * Resolve `ref` against the given repo via `git rev-parse --verify`. Reply
   * to the webview with the result. Caches `(repo, ref) → result` for the
   * panel's lifetime so repeated typing doesn't re-spawn git.
   */
  private async _sendValidation(repoFullPath: string, ref: string): Promise<void> {
    const result = await this._validateRef(repoFullPath, ref);
    void this._panel.webview.postMessage({
      command: "refValidation",
      repoFullPath,
      ref,
      result,
    });
  }

  /** Per-(repo, ref) memoized validation. */
  private readonly _validationCache = new Map<string, Promise<RefValidationResult>>();

  private _validateRef(repoFullPath: string, ref: string): Promise<RefValidationResult> {
    const key = `${normalizePath(repoFullPath)}::${ref}`;
    const cached = this._validationCache.get(key);
    if (cached) { return cached; }

    const promise: Promise<RefValidationResult> = (async () => {
      try {
        // `--end-of-options` so refs starting with `-` aren't mistaken for flags.
        const out = await execGitWithArgs(
          ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
          repoFullPath,
          { timeout: ConfigService.getGitTimeoutMs() },
        );
        const sha = out.trim();
        return { valid: true, resolvedSha: sha.slice(0, 7) };
      } catch (err) {
        const message = String(err).split("\n").find(line => line.trim().length > 0) ?? "Invalid ref";
        return { valid: false, message: message.trim() };
      }
    })();

    this._validationCache.set(key, promise);
    // Don't cache forever — the user might fetch new refs (so a previously
    // invalid ref becomes valid) or a remote ref might move (so a cached
    // `resolvedSha` goes stale). Failures expire fast; successes more slowly.
    void promise.then(r => {
      const ttl = r.valid ? 60_000 : 10_000;
      setTimeout(() => this._validationCache.delete(key), ttl);
    });
    return promise;
  }

  private _pushState(): void {
    const repos = this._collectRepos();
    const comparisons: SavedComparisonDTO[] = this.service.getAll().map(c => ({
      id: c.id,
      repoFullPath: c.repoFullPath,
      source: c.source,
      target: c.target,
      label: c.label,
      active: c.active,
      isHeatmapBaseline: c.isHeatmapBaseline,
      groupingMode: c.groupingMode,
      diffMode: c.diffMode,
    }));
    void this._panel.webview.postMessage({ command: "state", repos, comparisons });
  }

  private _pushHeatmapState(): void {
    const settings: HeatmapSettingsDTO = {
      enabled: ConfigService.isHeatmapEnabled(),
      autoApply: ConfigService.getBlameHeatmapAutoApply(),
      mode: WorkspaceStateManager.getBlameHeatmapMode() ?? "absolute",
    };
    void this._panel.webview.postMessage({ command: "heatmapState", settings });
  }

  private async _sendRefs(repoFullPath: string): Promise<void> {
    const key = normalizePath(repoFullPath) as NormalizedRepoPath;
    let promise = this._refsCache.get(key);
    if (!promise) {
      promise = getAvailableBranches(repoFullPath).catch(err => {
        log(`branchCompareSettings: getAvailableBranches failed for ${repoFullPath} — ${err}`, "warn");
        return [] as { name: string; relativeDate: string }[];
      });
      this._refsCache.set(key, promise);
    }
    const branches = await promise;
    void this._panel.webview.postMessage({
      command: "refs",
      repoFullPath,
      branches: branches.map(b => ({ name: b.name, relativeDate: b.relativeDate })),
    });
  }

  /** Build the list of workspace repos with current-branch hints for the picker. */
  private _collectRepos(): RepoDTO[] {
    const out: RepoDTO[] = [];
    for (const folder of this.freshFileProvider.workspaceFolders) {
      for (const repoRel of folder.gitRepos) {
        const repoFullPath = repoRel === ""
          ? folder.path
          : (path.join(folder.path, repoRel) as string);
        const normalized = normalizePath(repoFullPath) as NormalizedRepoPath;
        const name = repoRel === "" ? folder.name : path.basename(repoFullPath);
        out.push({
          fullPath: normalized,
          name,
          currentBranch: this.freshFileProvider.getRepoBranch(normalized),
        });
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }
}
