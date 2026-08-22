import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { AbsolutePath, NormalizedRepoPath } from "../pathTypes";
import { ConfigService } from "../config/configService";
import { execGitWithArgs } from "../git/gitOperations";

/**
 * Whether the repo has a commit-graph file. Resolves the real git dir via
 * `--git-common-dir`, so linked worktrees and submodules (where `.git` is a
 * file and the objects live in the main checkout) are answered correctly.
 * Errs on "true" — if we can't verify, don't nag.
 */
export async function hasCommitGraph(repoPath: string): Promise<boolean> {
  try {
    const out = await execGitWithArgs(["rev-parse", "--git-common-dir"], repoPath);
    const commonDir = path.resolve(repoPath, out.trim());
    return fs.existsSync(path.join(commonDir, "objects", "info", "commit-graph"))
      || fs.existsSync(path.join(commonDir, "objects", "info", "commit-graphs", "chain"));
  } catch {
    return true;
  }
}

const COMMIT_GRAPH_SETUP_COMMANDS = [
  "git maintenance start",
  "git commit-graph write --reachable --changed-paths",
].join("\n");

/**
 * One-shot warning toasts for repo-level breakage found during scanning. Each kind
 * dedupes per path for the session, so repeated refreshes against the same broken
 * state don't re-toast.
 */
export class RepoHealthNotifier {
  /** A history load slower than this suggests the repo would benefit from a commit-graph. */
  static readonly SLOW_LOAD_THRESHOLD_MS = 3000;

  /** Worktree paths already surfaced to the user. */
  private readonly notifiedBrokenWorktrees = new Set<string>();
  /** Repos already toasted for a corrupt index. */
  private readonly notifiedCorruptIndex = new Set<NormalizedRepoPath>();
  /** Repos already checked for a missing commit-graph (checked once per session, toasted at most once). */
  private readonly checkedCommitGraph = new Set<NormalizedRepoPath>();

  /**
   * Warn (once per path) when a directory looks like a git worktree but git no longer recognizes
   * it — typically a stale gitdir pointer after the worktree folder was moved. Such repos silently
   * drop out of the tree; the toast names them and offers the `git worktree repair` fix.
   */
  async notifyBrokenWorktrees(brokenWorktrees: AbsolutePath[]): Promise<void> {
    const fresh = brokenWorktrees.filter(p => !this.notifiedBrokenWorktrees.has(p));
    if (fresh.length === 0) {
      return;
    }
    fresh.forEach(p => this.notifiedBrokenWorktrees.add(p));

    const names = fresh.map(p => path.basename(p));
    const message = fresh.length === 1
      ? `Fresh File Explorer skipped "${names[0]}": it looks like a git worktree but its .git link is broken (its gitdir pointer is stale — common after moving the folder). That repository won't appear in the tree.`
      : `Fresh File Explorer skipped ${fresh.length} folders with broken git worktree links (${names.join(", ")}). They won't appear in the tree.`;

    const COPY = "Copy repair command";
    const LEARN = "Learn more";
    const choice = await vscode.window.showWarningMessage(message, COPY, LEARN);
    if (choice === COPY) {
      // Run from the worktree's owning repository checkout. We can't reliably know that path from
      // here, so hand the user the exact per-worktree commands keyed by absolute path.
      const command = fresh.map(p => `git worktree repair "${p}"`).join("\n");
      await vscode.env.clipboard.writeText(command);
    } else if (choice === LEARN) {
      await vscode.env.openExternal(
        vscode.Uri.parse("https://git-scm.com/docs/git-worktree#Documentation/git-worktree.txt-repair"),
      );
    }
  }

  /**
   * Suggest a commit-graph when a repo's history load was measurably slow and no
   * graph exists. Advice, not breakage — fires as an information toast, gated by
   * `freshFileExplorer.warnMissingCommitGraph` ("Don't ask again" turns it off
   * globally). `detect` is injectable for tests.
   */
  async notifyIfMissingCommitGraph(
    normalizedRepoPath: NormalizedRepoPath,
    loadMs: number,
    detect: (repoPath: string) => Promise<boolean> = hasCommitGraph,
  ): Promise<void> {
    if (loadMs < RepoHealthNotifier.SLOW_LOAD_THRESHOLD_MS) {
      return;
    }
    if (!ConfigService.getWarnMissingCommitGraph()) {
      return;
    }
    if (this.checkedCommitGraph.has(normalizedRepoPath)) {
      return;
    }
    this.checkedCommitGraph.add(normalizedRepoPath);

    if (await detect(normalizedRepoPath)) {
      return;
    }

    const seconds = (loadMs / 1000).toFixed(1);
    const message = `Fresh File Explorer spent ${seconds}s reading git history for "${path.basename(normalizedRepoPath)}". A commit-graph would speed this up — a one-time, reversible git optimization.`;

    const COPY = "Copy setup commands";
    const LEARN = "Learn more";
    const NEVER = "Don't ask again";
    const choice = await vscode.window.showInformationMessage(message, COPY, LEARN, NEVER);
    if (choice === COPY) {
      await vscode.env.clipboard.writeText(COMMIT_GRAPH_SETUP_COMMANDS);
    } else if (choice === LEARN) {
      const extensionUri = vscode.extensions.getExtension("frehu.fresh-file-explorer")?.extensionUri;
      if (extensionUri) {
        const docUri = vscode.Uri.joinPath(extensionUri, "docs", "commit-graph.md");
        await vscode.commands.executeCommand("markdown.showPreview", docUri);
      }
    } else if (choice === NEVER) {
      await ConfigService.setWarnMissingCommitGraph(false);
    }
  }

  /**
   * Warn once per repo when git reports a corrupt index while reading pending changes. Left
   * unsurfaced, this reads as "no pending changes" instead of "couldn't check" — the tree looks
   * clean while the working tree may not be.
   */
  async notifyCorruptIndex(
    normalizedRepoPath: NormalizedRepoPath,
    folderName: string,
    repoRelPath: string,
    error: string,
  ): Promise<void> {
    if (!/index file corrupt|bad signature/i.test(error)) {
      return;
    }
    if (this.notifiedCorruptIndex.has(normalizedRepoPath)) {
      return;
    }
    this.notifiedCorruptIndex.add(normalizedRepoPath);

    const repoLabel = repoRelPath ? `${folderName}/${repoRelPath}` : folderName;
    const message = `Fresh File Explorer couldn't read pending changes for "${repoLabel}": its git index is corrupt. Pending changes won't show up until it's fixed — committed history is unaffected.`;

    const LEARN = "How to fix";
    const choice = await vscode.window.showWarningMessage(message, LEARN);
    if (choice === LEARN) {
      const extensionUri = vscode.extensions.getExtension("frehu.fresh-file-explorer")?.extensionUri;
      if (extensionUri) {
        const docUri = vscode.Uri.joinPath(extensionUri, "docs", "git-index-corruption.md");
        await vscode.commands.executeCommand("markdown.showPreview", docUri);
      }
    }
  }
}
