import * as vscode from "vscode";

import { SavedComparisonsService } from "./savedComparisonsService";
import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { execGitWithArgs } from "../git/gitOperations";
import { getAvailableBranches } from "../git/gitCommitQueries";
import { ConfigService } from "../config/configService";
import { log } from "../extension/logger";
import { normalizePath } from "../utils";
import { getLocalResourceRoots } from "../utils/webviewPanelOptions";
import { NormalizedRepoPath } from "../pathTypes";
import { listWorkspaceRepos } from "../utils/pathUtils";
import { getBranchCompareSettingsHtml } from "./branchCompareSettingsPanelUI";
import {
  BranchCompareSettingsFromWebview,
  BranchCompareSettingsToWebview,
  HeatmapSettingsDTO,
  RefValidationResult,
  RepoDTO,
  SavedComparisonDTO,
} from "../webview/messages";
import { WorkspaceStateManager } from "../extension/workspaceStateManager";

/**
 * Webview view (bottom panel) for managing the saved branch comparisons.
 *
 * Responsibilities:
 *  - Render the table UI (HTML/CSS via `getBranchCompareSettingsHtml`)
 *  - Receive command messages from the webview, dispatch to the service
 *  - Push state back to the webview whenever the service fires onDidChange
 *  - Resolve ref autocompletes by calling `getAvailableBranches` on demand
 *
 * VS Code may dispose the view (panel closed, view moved) and resolve it again
 * later, so per-view subscriptions live in `_viewDisposables`.
 */
export class BranchCompareSettingsPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = "freshFileExplorer.branchCompareSettings";

  private _view: vscode.WebviewView | undefined;
  private readonly _viewDisposables: vscode.Disposable[] = [];
  /** Per-repo branch-list cache so repeated picker openings don't re-spawn git for-each-ref. */
  private readonly _refsCache = new Map<NormalizedRepoPath, Promise<{ name: string; relativeDate: string }[]>>();

  static register(
    extensionUri: vscode.Uri,
    service: SavedComparisonsService,
    freshFileProvider: FreshFileProvider,
  ): vscode.Disposable {
    const provider = new BranchCompareSettingsPanel(extensionUri, service, freshFileProvider);
    const registration = vscode.window.registerWebviewViewProvider(
      BranchCompareSettingsPanel.viewId,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } },
    );
    return vscode.Disposable.from(registration, provider);
  }

  static show(): void {
    void vscode.commands.executeCommand(`${BranchCompareSettingsPanel.viewId}.focus`);
  }

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: SavedComparisonsService,
    private readonly freshFileProvider: FreshFileProvider,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this._disposeView();
    this._view = view;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: getLocalResourceRoots(this.extensionUri),
    };
    const scriptUri = view.webview
      .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "branchCompareSettings.js"))
      .toString();
    const codiconCssUri = view.webview
      .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "codicons", "codicon.css"))
      .toString();
    view.webview.html = getBranchCompareSettingsHtml(
      view.webview.cspSource,
      scriptUri,
      codiconCssUri,
    );

    view.onDidDispose(() => {
      if (this._view === view) { this._disposeView(); }
    }, null, this._viewDisposables);

    view.webview.onDidReceiveMessage(
      async (msg: BranchCompareSettingsFromWebview) => this._handleMessage(msg),
      null,
      this._viewDisposables,
    );

    // Push fresh state on any service change so the table stays in sync with
    // tree-side mutations (toggle-active from the tree, blame-heatmap baseline
    // changes, etc.).
    this._viewDisposables.push(
      this.service.onDidChange(() => this._pushState()),
    );

    // FreshFileProvider's branch info populates async — re-push state when
    // it lands so the "current branch" hint in the source-ref dropdown is right.
    this._viewDisposables.push(
      this.freshFileProvider.onDidChangeTreeData(() => this._pushState()),
    );

    // Heatmap toggles + auto-apply live in user-config; the mode in workspace state.
    this._viewDisposables.push(
      WorkspaceStateManager.onDidChangeBlameHeatmapMode(() => this._pushHeatmapState()),
    );
    this._viewDisposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (
          e.affectsConfiguration("freshFileExplorer.heatmap") ||
          e.affectsConfiguration("freshFileExplorer.blameHeatmap")
        ) {
          this._pushHeatmapState();
        }
        // Keep the auto-follow checkbox in sync when toggled from settings.json.
        if (e.affectsConfiguration("freshFileExplorer.branchCompare.autoFollow")) {
          this._pushState();
        }
      }),
    );
  }

  dispose(): void {
    this._disposeView();
  }

  private _disposeView(): void {
    this._view = undefined;
    while (this._viewDisposables.length) {
      const d = this._viewDisposables.pop();
      if (d) { try { d.dispose(); } catch { /* swallow */ } }
    }
  }

  /** Typed outbound channel — every host→webview message goes through here. */
  private _post(msg: BranchCompareSettingsToWebview): void {
    void this._view?.webview.postMessage(msg);
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
        }
        break;
      case "setAutoFollow":
        await ConfigService.setAutoFollow(msg.enabled);
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
    this._post({
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
      hideReviewed: c.hideReviewed,
      auto: c.auto,
    }));
    this._post({ command: "state", repos, comparisons, autoFollow: ConfigService.getAutoFollow() });
  }

  private _pushHeatmapState(): void {
    const settings: HeatmapSettingsDTO = {
      enabled: ConfigService.isHeatmapEnabled(),
      autoApply: ConfigService.getBlameHeatmapAutoApply(),
      mode: WorkspaceStateManager.getBlameHeatmapMode() ?? "absolute",
    };
    this._post({ command: "heatmapState", settings });
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
    this._post({
      command: "refs",
      repoFullPath,
      branches: branches.map(b => ({ name: b.name, relativeDate: b.relativeDate })),
    });
  }

  /** Build the list of workspace repos with current-branch hints for the picker. */
  private _collectRepos(): RepoDTO[] {
    const out: RepoDTO[] = listWorkspaceRepos(this.freshFileProvider.workspaceFolders).map(repo => ({
      fullPath: repo.normalizedPath,
      name: repo.name,
      currentBranch: this.freshFileProvider.getRepoBranch(repo.normalizedPath),
    }));
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }
}
