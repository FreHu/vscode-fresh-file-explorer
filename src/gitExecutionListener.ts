import * as vscode from "vscode";
import { FreshFileProvider } from "./freshFileProvider";
import { ConfigService } from "./config/configService";
import { log } from "./utils/logger";
import { normalizePath } from "./utils";
import { BranchName, asBranchName } from "./types";

/**
 * Set up listener for git extension state changes
 */
export async function setupGitExtensionListener(
  context: vscode.ExtensionContext,
  freshFileProvider: FreshFileProvider,
): Promise<void> {
  /**
   * Check sync status for all repositories and update warnings
   */
  async function updateSyncWarnings(api: GitAPI): Promise<void> {
    const showCurrentBranchSync = ConfigService.getShowCurrentBranchSync();
    const showBaseBranchSync = ConfigService.getShowBaseBranchSync();

    const warnings: string[] = [];
    const branches = new Map<string, BranchName>();

    for (const repo of api.repositories) {
      const head = repo.state.HEAD;
      if (!head?.name) {
        continue;
      }

      // Store branch name for this repo
      branches.set(normalizePath(repo.rootUri.fsPath), asBranchName(head.name));

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
              warnings.push(`${repoName}⬆️ ${aheadCommits.length} commit(s) ahead of '${displayName}'`);
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

    freshFileProvider.setSyncWarnings(warnings);
    freshFileProvider.setRepoBranches(branches);
  }

  try {
    const gitExtension = vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (!gitExtension) {
      log("Git extension not found, SCM change detection disabled", "warn");
      return;
    }

    const git = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
    const api = git.getAPI(1);

    // Initial sync check
    await updateSyncWarnings(api);

    // Debounce refresh to avoid excessive updates
    let refreshTimeout: NodeJS.Timeout | undefined;
    const debouncedRefresh = async () => {
      if (refreshTimeout) {
        clearTimeout(refreshTimeout);
      }
      refreshTimeout = setTimeout(async () => {
        // Skip refresh if we have no repositories - nothing to update
        if (!freshFileProvider.hasGitRepositories()) {
          log("Git state changed, but no repositories found - skipping refresh");
          refreshTimeout = undefined;
          return;
        }

        log("Git state changed, refreshing");
        await updateSyncWarnings(api);
        freshFileProvider.refresh();
        refreshTimeout = undefined;
      }, 500); // 500ms debounce
    };

    // Listen for repository state changes
    context.subscriptions.push(
      api.onDidChangeState(async () => {
        await debouncedRefresh();
      }),
    );

    // Also listen for changes in each repository
    for (const repo of api.repositories) {
      context.subscriptions.push(
        repo.state.onDidChange(async () => {
          await debouncedRefresh();
        }),
      );
    }

    // Listen for new repositories being opened
    context.subscriptions.push(
      api.onDidOpenRepository((repo: Repository) => {
        context.subscriptions.push(
          repo.state.onDidChange(async () => {
            await debouncedRefresh();
          }),
        );
      }),
    );

    log("Git extension integration enabled");
  } catch (error) {
    log(`Failed to set up git extension listener: ${error}`, "warn");
  }
}

interface GitExtension {
  getAPI(version: number): GitAPI;
}

interface GitAPI {
  onDidChangeState: vscode.Event<void>;
  onDidOpenRepository: vscode.Event<Repository>;
  repositories: Repository[];
}

interface UpstreamRef {
  remote: string;
  name: string;
}

interface Branch {
  name?: string;
  upstream?: UpstreamRef;
  ahead?: number;
  behind?: number;
}

interface Repository {
  rootUri: vscode.Uri;
  state: RepositoryState;
  getBranchBase(name: string): Promise<Branch | undefined>;
  log(options?: { maxEntries?: number; range?: string }): Promise<{ hash: string }[]>;
}

interface RepositoryState {
  HEAD: Branch | undefined;
  onDidChange: vscode.Event<void>;
}
