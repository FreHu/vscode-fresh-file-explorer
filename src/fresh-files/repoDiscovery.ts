import * as vscode from "vscode";

import { DataCollector, RepoInfo } from "./dataCollector";
import { WorkspaceFolderInfo } from "../types";
import { AbsolutePath } from "../pathTypes";
import { log } from "../extension/logger";

/**
 * Owns repo discovery: the workspace walk, its results (scannable repos plus
 * display-only uninitialized submodules), the in-flight dedup so a
 * discovery-only caller and a full load share one walk, and `onReposReady`.
 *
 * Cancellation stays with the caller: `discoverRepositories` takes the
 * caller's `assertNotCancelled` and never applies results from a cancelled walk.
 */
export class RepoDiscovery {
  private _reposDiscovered = false;
  // In-flight walk, shared between discovery-only callers and full loads.
  private discoveryPromise: Promise<void> | undefined;
  // Only scannable repos — uninitialized submodules are held separately.
  private _resolvedRepos: RepoInfo[] = [];
  // Uninitialized (not-checked-out) submodules, display only. Deliberately kept
  // out of resolvedRepos and folder.gitRepos so no scan path ever runs git in them.
  private _uninitializedSubmodules: RepoInfo[] = [];

  private readonly _onReposReady = new vscode.EventEmitter<void>();
  /** Fires every time discovery transitions to "done" — activation and after each reset. */
  readonly onReposReady = this._onReposReady.event;

  constructor(private readonly deps: {
    getWorkspaceFolders: () => WorkspaceFolderInfo[];
    onBrokenWorktrees: (paths: AbsolutePath[]) => void;
  }) {}

  get reposDiscovered(): boolean { return this._reposDiscovered; }
  /** All scannable repos with pre-computed absolute and normalized paths. */
  get resolvedRepos(): RepoInfo[] { return this._resolvedRepos; }
  get uninitializedSubmodules(): RepoInfo[] { return this._uninitializedSubmodules; }

  /** Forget everything — the next discoverRepositories re-walks the workspace. */
  reset(): void {
    this._reposDiscovered = false;
    this._resolvedRepos = [];
    this._uninitializedSubmodules = [];
  }

  /**
   * Deduplicating front for `runDiscovery`, so a discovery-only caller and a
   * full load starting at the same time share one workspace walk. No-op once
   * repos are discovered.
   */
  async discoverRepositories(assertNotCancelled: () => void): Promise<void> {
    // Skip if repos already discovered (soft refresh)
    if (this._reposDiscovered) {
      log(`Reloading files for ${this._resolvedRepos.length} known Git repository(ies) (skipping discovery)`);
      return;
    }

    if (this.discoveryPromise) {
      // Swallow the shared promise's cancellation — it belongs to the originating
      // caller, not to us. We re-check and run our own discovery below.
      await this.discoveryPromise.catch(() => {});
      assertNotCancelled();
      if (this._reposDiscovered) { return; }
    }

    this.discoveryPromise = this.runDiscovery(assertNotCancelled)
      .finally(() => { this.discoveryPromise = undefined; });
    return this.discoveryPromise;
  }

  private async runDiscovery(assertNotCancelled: () => void): Promise<void> {
    const workspaceFolders = this.deps.getWorkspaceFolders();
    const { repos: discoveredRepos, brokenWorktrees } = await DataCollector.discoverAllRepos(workspaceFolders);
    assertNotCancelled();

    // Surface broken worktrees (gitdir link stale, e.g. after a move). These silently failed to
    // load as repos; without a nudge the user just sees a too-short repo list.
    this.deps.onBrokenWorktrees(brokenWorktrees);

    // Apply discovered repos only after confirming we're not cancelled,
    // so state is never mutated by a stale load.
    this._uninitializedSubmodules = discoveredRepos.filter(r => r.isUninitialized);
    const scannableRepos = discoveredRepos.filter(r => !r.isUninitialized);

    // Back-fill folder.gitRepos for consumers that accept WorkspaceFolderInfo[] directly.
    for (const folder of workspaceFolders) {
      folder.gitRepos = [];
    }
    for (const repo of scannableRepos) {
      repo.folder.gitRepos.push(repo.repoRelPath);
    }
    this._resolvedRepos = scannableRepos;

    const uninitializedNote = this._uninitializedSubmodules.length > 0
      ? ` (+${this._uninitializedSubmodules.length} uninitialized submodule(s), display only)`
      : "";
    log(`Discovered ${scannableRepos.length} Git repository(ies) across ${workspaceFolders.length} workspace folder(s)${uninitializedNote}`);

    this._reposDiscovered = true;
    this._onReposReady.fire();
  }
}
