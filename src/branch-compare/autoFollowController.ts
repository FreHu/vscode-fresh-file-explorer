import * as vscode from "vscode";

import { SavedComparisonsService } from "./savedComparisonsService";
import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { ConfigService } from "../config/configService";
import { getCurrentBranch, getDefaultBranch } from "../git/gitCommitQueries";
import { log } from "../extension/logger";
import { listWorkspaceRepos } from "../utils/pathUtils";
import { AbsolutePath, NormalizedRepoPath } from "../pathTypes";
import {
  computeDesiredFollows,
  reconcileFollows,
  RepoHeadState,
} from "./autoFollow";

/**
 * Auto-follow: keep one live branch-compare section per diverged repo/worktree,
 * so in-progress work shows up with no manual setup — whoever or whatever is
 * driving it (you on a feature branch, a parallel worktree, an LLM agent).
 *
 * Whenever a repo's HEAD branch differs from its default branch (on a branch or
 * in a sibling worktree — both surface as repos in FFE's discovery), this
 * controller adds an `auto`-flagged `SavedComparison` (`HEAD..<default>`, merge
 * mode) via the service. Those are ordinary persisted comparisons — they show in
 * the settings panel, and the existing refresh machinery live-updates them on
 * every commit, stage, and file save. Deleting one dismisses it; editing one
 * adopts it as a manual comparison (both handled in the service).
 *
 * The pure decision logic lives in {@link ./autoFollow} and is unit-tested. This
 * class is just the shell: gather live git state, debounce, reconcile.
 */
export class AutoFollowController implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private enabled: boolean;
  /** Default branch is stable per repo; resolved lazily and cached. */
  private readonly defaultBranchCache = new Map<NormalizedRepoPath, string | undefined>();
  /** `(repo→head→base)` signature of the last evaluated tick, to skip no-op churn. */
  private lastSignature = "";

  constructor(
    private readonly savedComparisons: SavedComparisonsService,
    private readonly freshFileProvider: FreshFileProvider,
  ) {
    this.enabled = ConfigService.getAutoFollow();

    // FFP fires this after branch-label updates and every refresh — the cheapest
    // hook that covers "a worktree appeared / checked out a new branch".
    this.subscriptions.push(
      this.freshFileProvider.onDidChangeTreeData(() => this.schedule()),
    );

    if (this.enabled) {
      if (this.freshFileProvider.areReposReady) {
        this.schedule();
      } else {
        this.subscriptions.push(this.freshFileProvider.onReposReady(() => this.schedule()));
      }
    } else {
      // Purge any auto rows persisted while the feature was on in a prior session.
      this.savedComparisons.removeAllAutoFollows();
    }
  }

  /** Re-read the enabled flag after a config change. Clears all follows when turned off. */
  onConfigChanged(): void {
    const next = ConfigService.getAutoFollow();
    if (next === this.enabled) { return; }
    this.enabled = next;
    this.lastSignature = "";
    if (!this.enabled) {
      this.savedComparisons.removeAllAutoFollows();
    } else {
      this.schedule();
    }
  }

  private schedule(): void {
    if (!this.enabled) { return; }
    if (this.timer) { clearTimeout(this.timer); }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.evaluate().catch(e =>
        log(`autoFollow: evaluate failed: ${e instanceof Error ? e.message : String(e)}`, "warn"),
      );
    }, 500);
  }

  private async evaluate(): Promise<void> {
    if (!this.enabled || !this.freshFileProvider.areReposReady) { return; }

    const repos = listWorkspaceRepos(this.freshFileProvider.workspaceFolders);

    // Resolve HEAD per repo. Prefer the git-extension-fed branch map (free), but
    // fall back to git — a sibling worktree FFE discovered may not have been
    // opened by the VS Code git extension, in which case the map has no entry.
    const states: RepoHeadState[] = [];
    for (const r of repos) {
      const headBranch =
        this.freshFileProvider.getRepoBranch(r.normalizedPath) ??
        await getCurrentBranch(r.repoFullPath);
      states.push({
        repoFullPath: r.normalizedPath,
        headBranch,
        baseBranch: await this.resolveDefaultBranch(r.normalizedPath, r.repoFullPath),
      });
    }

    // Skip the reconcile + tree churn when nothing moved. Base is part of the
    // signature, not just HEAD — a repo whose base resolved late (no `origin/HEAD`
    // on the first tick) must still get reconciled once it does.
    const signature = states
      .map(s => `${s.repoFullPath}@${s.headBranch ?? ""}@${s.baseBranch ?? ""}`)
      .sort()
      .join("|");
    if (signature === this.lastSignature) { return; }
    this.lastSignature = signature;

    const existingAuto = this.savedComparisons.getAll().filter(c => c.auto);
    const desired = computeDesiredFollows(states, this.savedComparisons.getDismissedAutoFollows());
    const { toAdd, toRemoveIds } = reconcileFollows(desired, existingAuto);
    if (toAdd.length === 0 && toRemoveIds.length === 0) { return; }

    log(`autoFollow: +${toAdd.length} / -${toRemoveIds.length} follow(s)`);
    this.savedComparisons.applyAutoReconcile(
      // Label by branch — the identity of the work across sibling worktrees.
      toAdd.map(d => ({ repoFullPath: d.repoFullPath, target: d.target, label: d.headBranch })),
      toRemoveIds,
    );
  }

  private async resolveDefaultBranch(key: NormalizedRepoPath, full: AbsolutePath): Promise<string | undefined> {
    const cached = this.defaultBranchCache.get(key);
    if (cached !== undefined) { return cached; }
    // Only cache a resolved name. A repo with a non-standard default (e.g. `trunk`)
    // and no `origin/HEAD` yet returns undefined; leaving it uncached lets a later
    // tick retry once the symref exists, rather than never following it this session.
    const base = await getDefaultBranch(full).catch(() => undefined);
    if (base !== undefined) { this.defaultBranchCache.set(key, base); }
    return base;
  }

  dispose(): void {
    if (this.timer) { clearTimeout(this.timer); }
    for (const s of this.subscriptions) { s.dispose(); }
  }
}
