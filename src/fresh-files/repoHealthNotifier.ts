import * as vscode from "vscode";
import * as path from "path";
import { AbsolutePath, NormalizedRepoPath } from "../pathTypes";

/**
 * One-shot warning toasts for repo-level breakage found during scanning. Each kind
 * dedupes per path for the session, so repeated refreshes against the same broken
 * state don't re-toast.
 */
export class RepoHealthNotifier {
  /** Worktree paths already surfaced to the user. */
  private readonly notifiedBrokenWorktrees = new Set<string>();
  /** Repos already toasted for a corrupt index. */
  private readonly notifiedCorruptIndex = new Set<NormalizedRepoPath>();

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
