import * as vscode from "vscode";
import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { ConfigService } from "../config/configService";
import { log } from "../extension/logger";
import { normalizePath } from "../utils";
import { NormalizedRepoPath } from "../pathTypes";
import { BranchName, asBranchName } from "../types";

/** Minimal repository interface exposed to consumers outside this module. */
export interface GitRepository {
  rootUri: vscode.Uri;
  state: GitRepositoryState;
}

/** Minimal Git API interface passed to external consumers (e.g. BlameHeatmapController). */
export interface GitApi {
  onDidOpenRepository: vscode.Event<GitRepository>;
  repositories: readonly GitRepository[];
}

/**
 * Set up listener for git extension state changes
 */
export async function setupGitExtensionListener(
  context: vscode.ExtensionContext,
  freshFileProvider: FreshFileProvider,
  onGitApiReady?: (api: GitApi) => void,
): Promise<void> {
  /**
   * Check sync status for all repositories and update warnings
   */
  async function updateSyncWarnings(api: InternalGitAPI, silent = false): Promise<void> {
    const showCurrentBranchSync = ConfigService.getShowCurrentBranchSync();
    const showBaseBranchSync = ConfigService.getShowBaseBranchSync();

    const warnings: string[] = [];
    const branches = new Map<NormalizedRepoPath, BranchName>();

    for (const repo of api.repositories) {
      const head = repo.state.HEAD;
      // Skip detached HEADs and tag checkouts (type 0 = local branch; undefined = assume branch for safety)
      if (!head?.name || (head.type !== undefined && head.type !== 0)) {
        continue;
      }

      // Store branch name for this repo
      branches.set(normalizePath(repo.rootUri.fsPath) as NormalizedRepoPath, asBranchName(head.name));

      const repoName = api.repositories.length > 1 ? `[${vscode.workspace.asRelativePath(repo.rootUri)}] ` : "";

      // Check upstream sync status (only if tracking is set up and enabled)
      if (showCurrentBranchSync && head.upstream) {
        if (head.behind && head.behind > 0) {
          warnings.push(`${repoName}⬇️ ${head.behind} commit(s) behind ${head.upstream.remote}/${head.upstream.name}`);
        }
        if (head.ahead && head.ahead > 0) {
          warnings.push(`${repoName}⬆️ ${head.ahead} unpushed commit(s)`);
        }
      }

      // Check for changes in the base branch (what we branched from)
      // This checks the remote tracking branch of the base to catch updates before local pull
      if (showBaseBranchSync) {
        try {
          const baseBranch = await repo.getBranchBase(head.name);
          if (baseBranch?.name && baseBranch.name !== head.name) {
            // Prefer checking remote tracking branch if available (e.g., origin/main)
            // This catches updates pushed to remote before you pull locally
            let targetRef = baseBranch.name;
            if (baseBranch.upstream) {
              targetRef = `${baseBranch.upstream.remote}/${baseBranch.upstream.name}`;
            }

            const displayName = baseBranch.upstream
              ? `${baseBranch.upstream.remote}/${baseBranch.upstream.name}`
              : baseBranch.name;

            // Count commits in current branch not in base (how far ahead we are)
            const aheadRange = `${targetRef}..${head.name}`;
            const aheadCommits = await repo.log({ maxEntries: 100, range: aheadRange });
            if (aheadCommits.length > 0) {
              warnings.push(`${repoName}⬆️ ${aheadCommits.length} commit(s) ahead of base branch '${displayName}'`);
            }

            // Count commits in base not in current branch (need to merge/rebase)
            const behindRange = `${head.name}..${targetRef}`;
            const behindCommits = await repo.log({ maxEntries: 100, range: behindRange });
            if (behindCommits.length > 0) {
              warnings.push(
                `${repoName}📥 ${behindCommits.length} commit(s) in '${displayName}' not in current branch`,
              );
            }
          }
        } catch (error) {
          // getBranchBase or log may not be available in older git extension versions
          log(`Could not check base branch: ${error}`, "warn");
        }
      }
    }

    freshFileProvider.setSyncWarnings(warnings, silent);
    freshFileProvider.setRepoBranches(branches, silent);
  }

  try {
    const gitExtension = vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (!gitExtension) {
      log("Git extension not found, SCM change detection disabled", "warn");
      return;
    }

    const git = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
    const api = git.getAPI(1);

    // Notify external consumers (e.g. BlameHeatmapController) with the resolved API.
    onGitApiReady?.(api as unknown as GitApi);

    // Initial sync check
    await updateSyncWarnings(api);

    // Per-repo snapshots: track meaningful state so we can skip refreshes
    // when only remote tracking counts (ahead/behind) change — e.g. on background fetches.
    const repoSnapshots = new Map<NormalizedRepoPath, RepoSnapshot>();

    function takeSnapshot(repo: InternalRepository): RepoSnapshot {
      return {
        commit: repo.state.HEAD?.commit,
        branch: repo.state.HEAD?.name,
        indexLength: repo.state.indexChanges.length,
        workingTreeLength: repo.state.workingTreeChanges.length,
        ahead: repo.state.HEAD?.ahead,
        behind: repo.state.HEAD?.behind,
      };
    }

    for (const repo of api.repositories) {
      repoSnapshots.set(normalizePath(repo.rootUri.fsPath) as NormalizedRepoPath, takeSnapshot(repo));
    }

    // Track the pendingRefreshVersion we last acted on, to avoid duplicate
    // refreshes when onDidSaveTextDocument already triggered refreshPending().
    let lastHandledPendingVersion = freshFileProvider.pendingRefreshVersion;

    // Debounce state
    let refreshTimeout: NodeJS.Timeout | undefined;
    // Set to true when a change that bypasses snapshot comparison is pending
    // (e.g. the git API itself changed state, or a brand-new repo was opened)
    let pendingForceRefresh = false;

    const handleRefresh = async () => {
      refreshTimeout = undefined;

      if (!freshFileProvider.hasGitRepositories()) {
        log("Git state changed, but no repositories found - skipping refresh");
        return;
      }

      // full refresh   — commit hash or branch changed
      // pending refresh — only index/working-tree counts changed (stage, save, discard)
      // sync only       — only ahead/behind changed (background fetch)
      const force = pendingForceRefresh;
      pendingForceRefresh = false;

      const reposNeedingFullRefresh = new Set<NormalizedRepoPath>();
      const reposNeedingPendingRefresh = new Set<NormalizedRepoPath>();
      let needsBranchOnlyUpdate = false;
      // Tracked before snapshot update so the else-branch sync check can use pre-update values.
      let aheadBehindChanged = false;

      if (!force) {
        for (const repo of api.repositories) {
          const key = normalizePath(repo.rootUri.fsPath) as NormalizedRepoPath;
          const prev = repoSnapshots.get(key);
          const curr = takeSnapshot(repo);
          if (!prev) {
            // Brand-new repo we haven't seen before — force a refresh.
            reposNeedingFullRefresh.add(key);
          } else if (prev.commit !== curr.commit || prev.branch !== curr.branch) {
            // Commit or branch differs — but only treat it as a real change if the
            // previous snapshot had a known state. If both were undefined the git
            // extension simply hadn't finished initialising when we snapshotted it;
            // the in-progress load will naturally capture the correct state.
            if (prev.commit !== undefined || prev.branch !== undefined) {
              if (prev.commit !== curr.commit) {
                // Commit changed — files may differ, need full git log refresh.
                reposNeedingFullRefresh.add(key);
              } else {
                // Only branch name changed with the same commit (e.g. `git checkout -b new-branch`).
                // No file content changed, so skip git log and just update branch labels / sync warnings.
                needsBranchOnlyUpdate = true;
              }
            }
          } else if (prev.indexLength !== curr.indexLength || prev.workingTreeLength !== curr.workingTreeLength) {
            reposNeedingPendingRefresh.add(key);
          } else if (prev.ahead !== curr.ahead || prev.behind !== curr.behind) {
            // Only remote sync counts changed (e.g. background fetch). No file or index change.
            aheadBehindChanged = true;
          }
        }
      }

      const needsFullRefresh = force || reposNeedingFullRefresh.size > 0;
      const needsPendingRefresh = !needsFullRefresh && reposNeedingPendingRefresh.size > 0;

      // Update snapshots regardless of what we decided
      for (const repo of api.repositories) {
        repoSnapshots.set(normalizePath(repo.rootUri.fsPath) as NormalizedRepoPath, takeSnapshot(repo));
      }

      if (needsFullRefresh) {
        const scopeDesc = force ? "" : ` for repo(s): ${[...reposNeedingFullRefresh].join(", ")}`;
        log(`Git commit or branch changed, doing full refresh${scopeDesc}`);
        await updateSyncWarnings(api, true);
        freshFileProvider.refresh({ targetRepoPaths: force ? undefined : [...reposNeedingFullRefresh] });
      } else if (needsBranchOnlyUpdate) {
        log("New branch created from same commit — updating branch labels and sync warnings only");
        await updateSyncWarnings(api);
      } else if (needsPendingRefresh) {
        // Check if a file-save-triggered refreshPending() already ran while
        // the debounce was counting down. If so, just re-snapshot and skip.
        if (freshFileProvider.pendingRefreshVersion !== lastHandledPendingVersion) {
          log("Git working tree changed, but pending refresh already done via file save — skipping");
          await updateSyncWarnings(api, true);
        } else {
          const scopeDesc = ` for repo(s): ${[...reposNeedingPendingRefresh].join(", ")}`;
          log(`Git working tree or index changed, refreshing pending files only${scopeDesc}`);
          if (needsBranchOnlyUpdate) {
            // Branch rename co-occurring with a working-tree change in another repo —
            // run a full sync warning update so branch labels are refreshed too.
            await updateSyncWarnings(api);
          } else {
            await updateSyncWarnings(api, true);
          }
          await freshFileProvider.refreshPending([...reposNeedingPendingRefresh]);
        }
        lastHandledPendingVersion = freshFileProvider.pendingRefreshVersion;
      } else {
        // Check whether ahead/behind counts actually changed (background fetch).
        // If nothing at all changed, the git extension fired a spurious event — skip entirely.
        if (aheadBehindChanged) {
          log("Git remote sync counts changed, updating sync warnings only");
          await updateSyncWarnings(api);
        } else {
          log("Git state event ignored - no reason to do any update");
        }
      }
    };

    const scheduleRefresh = (force = false) => {
      if (force) {
        pendingForceRefresh = true;
      }
      if (refreshTimeout) {
        clearTimeout(refreshTimeout);
      }
      refreshTimeout = setTimeout(() => {
        handleRefresh().catch(e =>
          log(`git-state refresh failed: ${e instanceof Error ? e.message : String(e)}`, "error"),
        );
      }, 500);
    };

    // Re-run repository discovery when a brand-new repo is opened (e.g. `git worktree add`).
    // Debounced so creating several worktrees at once (or the initial open burst) collapses into a single re-discovery.
    let rediscoverTimeout: NodeJS.Timeout | undefined;
    const scheduleRediscover = () => {
      if (rediscoverTimeout) {
        clearTimeout(rediscoverTimeout);
      }
      rediscoverTimeout = setTimeout(() => {
        rediscoverTimeout = undefined;
        log("New git repository/worktree detected — re-running discovery");
        freshFileProvider.hardRefresh();
      }, 500);
    };

    // Listen for git API state changes (extension init/deinit).
    // We intentionally do NOT force here — the initial git extension activation fires
    // this event before any repo state is populated, which would cancel the in-flight
    // load for no reason. Snapshot comparison in handleRefresh is sufficient to detect
    // any real branch/commit change that follows.
    context.subscriptions.push(
      api.onDidChangeState(() => scheduleRefresh()),
    );

    // Listen for per-repo state changes — snapshot comparison decides whether to refresh
    for (const repo of api.repositories) {
      context.subscriptions.push(
        repo.state.onDidChange(() => scheduleRefresh()),
      );
    }

    // Listen for new repositories being opened
    context.subscriptions.push(
      api.onDidOpenRepository((repo: InternalRepository) => {
        const key = normalizePath(repo.rootUri.fsPath) as NormalizedRepoPath;
        // Snapshot the new repo immediately so first change can be compared
        repoSnapshots.set(key, takeSnapshot(repo));
        context.subscriptions.push(
          repo.state.onDidChange(() => scheduleRefresh()),
        );

        // If FFE has already finished its initial discovery and this is a repo within the
        // workspace that we don't yet track, it's newly created (most often a worktree) — re-run
        // discovery so it shows up without a manual refresh. The areReposReady gate skips the
        // startup burst (those repos are picked up by the initial discovery anyway), and
        // knowsRepoPath avoids a redundant hard refresh for repos we already have.
        if (
          freshFileProvider.areReposReady &&
          freshFileProvider.isWithinWorkspace(key) &&
          !freshFileProvider.knowsRepoPath(key)
        ) {
          scheduleRediscover();
        }
      }),
    );

    // Listen for repositories being closed (e.g. `git worktree remove`). Drop the snapshot and,
    // if FFE currently tracks it, re-run discovery so the stale repo leaves the tree.
    context.subscriptions.push(
      api.onDidCloseRepository((repo: InternalRepository) => {
        const key = normalizePath(repo.rootUri.fsPath) as NormalizedRepoPath;
        repoSnapshots.delete(key);
        if (freshFileProvider.areReposReady && freshFileProvider.knowsRepoPath(key)) {
          scheduleRediscover();
        }
      }),
    );

    log("Git extension integration enabled");
  } catch (error) {
    log(`Failed to set up git extension listener: ${error}`, "warn");
  }
}

interface GitExtension {
  getAPI(version: number): InternalGitAPI;
}

interface InternalGitAPI {
  onDidChangeState: vscode.Event<void>;
  onDidOpenRepository: vscode.Event<InternalRepository>;
  onDidCloseRepository: vscode.Event<InternalRepository>;
  repositories: InternalRepository[];
}

interface UpstreamRef {
  remote: string;
  name: string;
}

interface Branch {
  name?: string;
  type?: number; // RefType: 0 = Head (branch), 1 = RemoteHead, 2 = Tag
  commit?: string;
  upstream?: UpstreamRef;
  ahead?: number;
  behind?: number;
}

interface Change {
  uri: vscode.Uri;
}

export interface GitRepository {
  rootUri: vscode.Uri;
  state: GitRepositoryState;
}

/** Full repository interface including methods used only inside the listener. */
interface InternalRepository extends GitRepository {
  getBranchBase(name: string): Promise<Branch | undefined>;
  log(options?: { maxEntries?: number; range?: string }): Promise<{ hash: string }[]>;
}

export interface GitRepositoryState {
  HEAD: Branch | undefined;
  indexChanges: Change[];
  workingTreeChanges: Change[];
  onDidChange: vscode.Event<void>;
}

interface RepoSnapshot {
  commit: string | undefined;
  branch: string | undefined;
  indexLength: number;
  workingTreeLength: number;
  ahead: number | undefined;
  behind: number | undefined;
}
