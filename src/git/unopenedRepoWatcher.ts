import * as fs from "fs";
import * as vscode from "vscode";

import { log } from "../extension/logger";
import { NormalizedRepoPath } from "../pathTypes";
import { normalizePath } from "../utils";
import { GitApi } from "./gitExecutionListener";
import { execGitWithArgs } from "./gitOperations";
import { branchFromHeadFile, classifyRepoChange, RepoChangeKind, WatchedRepoDirs } from "./repoChangeKind";

interface DiscoveredRepo {
  normalizedRepoPath: NormalizedRepoPath;
  gitDir?: string;
  commonDir?: string;
}

interface Watched {
  dirs: WatchedRepoDirs;
  commit: string | undefined;
  watchers: vscode.Disposable[];
  pending: Set<RepoChangeKind>;
  timer: NodeJS.Timeout | undefined;
}

const caseInsensitive = process.platform === "win32";
const pathKey = (p: string) => caseInsensitive ? p.toLowerCase() : p;

/**
 * Live updates for discovered repos the git extension doesn't have open: linked
 * worktrees (it opens those only with `git.detectWorktrees`), repos deeper than
 * `git.repositoryScanMaxDepth`, or every repo when git is disabled. Repos it has
 * open keep using its events, so each repo has exactly one source.
 */
export class UnopenedRepoWatcher implements vscode.Disposable {
  private readonly watched = new Map<string, Watched>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private openInGitExtension = new Set<string>();
  private connected = false;
  private api: GitApi | undefined;

  constructor(private readonly deps: {
    onReposReady: vscode.Event<void>;
    getRepos(): readonly DiscoveredRepo[];
    onHeadChanged(repoPath: NormalizedRepoPath): void;
    onPendingChanged(repoPath: NormalizedRepoPath): void;
  }) {
    this.subscriptions.push(deps.onReposReady(() => this.sync()));
  }

  /** Start watching once it's known which repos the git extension has open; `undefined` when it isn't available. */
  connect(api: GitApi | undefined): void {
    if (this.connected) { return; }
    this.connected = true;
    this.api = api;
    if (api) {
      this.subscriptions.push(
        api.onDidOpenRepository(() => this.sync()),
        api.onDidCloseRepository(() => this.sync()),
      );
    }
    this.sync();
  }

  private sync(): void {
    if (!this.connected) { return; }
    this.openInGitExtension = new Set((this.api?.repositories ?? []).map(r => pathKey(normalizePath(r.rootUri.fsPath))));
    const wanted = new Map<string, DiscoveredRepo>();
    for (const repo of this.deps.getRepos()) {
      if (repo.gitDir && repo.commonDir && !this.openInGitExtension.has(pathKey(repo.normalizedRepoPath))) {
        wanted.set(repo.normalizedRepoPath, repo);
      }
    }
    for (const [path, w] of this.watched) {
      if (!wanted.has(path)) {
        this.stop(w);
        this.watched.delete(path);
        log(`Live updates for ${path}: handed over to the git extension, or no longer discovered`);
      }
    }
    for (const [path, repo] of wanted) {
      if (!this.watched.has(path)) { this.start(repo); }
    }
  }

  private start(repo: DiscoveredRepo): void {
    const root = repo.normalizedRepoPath;
    const w: Watched = {
      dirs: { root, gitDir: repo.gitDir!, commonDir: repo.commonDir!, branch: readBranch(repo.gitDir!) },
      commit: undefined,
      watchers: [],
      pending: new Set(),
      timer: undefined,
    };
    // Recursive patterns, so files.watcherExclude applies (keeps .git/objects out).
    // A worktree's git dir is under its common dir; a main checkout's common dir is under its root.
    const bases = w.dirs.commonDir.startsWith(root + "/") ? [root] : [root, w.dirs.commonDir];
    for (const base of bases) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), "**"));
      const onEvent = (uri: vscode.Uri) => this.onFileEvent(w, normalizePath(uri.fsPath));
      watcher.onDidCreate(onEvent);
      watcher.onDidChange(onEvent);
      watcher.onDidDelete(onEvent);
      w.watchers.push(watcher);
    }
    this.watched.set(root, w);
    void resolveHead(root).then(commit => { w.commit ??= commit; });
    log(`Live updates for ${root}: watching it directly (not open in the git extension)`);
  }

  private onFileEvent(w: Watched, path: string): void {
    const kind = classifyRepoChange(path, w.dirs, caseInsensitive);
    if (kind === "ignore") { return; }
    w.pending.add(kind);
    clearTimeout(w.timer);
    w.timer = setTimeout(() => void this.flush(w), 500);
  }

  private async flush(w: Watched): Promise<void> {
    w.timer = undefined;
    const kinds = new Set(w.pending);
    w.pending.clear();
    const repoPath = w.dirs.root as NormalizedRepoPath;
    if (kinds.has("head")) {
      const branch = readBranch(w.dirs.gitDir);
      const commit = await resolveHead(repoPath);
      const moved = commit !== w.commit || branch !== w.dirs.branch;
      w.dirs.branch = branch;
      w.commit = commit;
      if (moved) {
        log(`Live updates for ${repoPath}: HEAD moved to ${commit?.slice(0, 7) ?? "unknown"}${branch ? ` on ${branch}` : ""}`);
        this.deps.onHeadChanged(repoPath);
        return;
      }
    }
    if (kinds.has("pending") || kinds.has("head")) {
      this.deps.onPendingChanged(repoPath);
    }
  }

  private stop(w: Watched): void {
    clearTimeout(w.timer);
    for (const watcher of w.watchers) { watcher.dispose(); }
  }

  dispose(): void {
    for (const w of this.watched.values()) { this.stop(w); }
    this.watched.clear();
    for (const s of this.subscriptions) { s.dispose(); }
  }
}

function readBranch(gitDir: string): string | undefined {
  try {
    return branchFromHeadFile(fs.readFileSync(`${gitDir}/HEAD`, "utf8"));
  } catch {
    return undefined;
  }
}

async function resolveHead(repoPath: string): Promise<string | undefined> {
  try {
    return (await execGitWithArgs(["rev-parse", "--verify", "-q", "HEAD"], repoPath)).trim() || undefined;
  } catch {
    return undefined;
  }
}
