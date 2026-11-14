import * as fs from "fs";
import * as vscode from "vscode";

import { log } from "../extension/logger";
import { normalizePath } from "../utils";
import { diffWorktrees, worktreePathFromGitdirFile } from "./worktreeDiff";

async function listLiveWorktrees(commonDir: string): Promise<string[]> {
  const worktreesDir = `${commonDir}/worktrees`;
  const names = await fs.promises.readdir(worktreesDir).catch(() => [] as string[]);
  const paths = await Promise.all(names.map(async name => {
    const content = await fs.promises.readFile(`${worktreesDir}/${name}/gitdir`, "utf8").catch(() => undefined);
    const wt = content === undefined ? undefined : worktreePathFromGitdirFile(content);
    return wt && fs.existsSync(`${wt}/.git`) ? wt : undefined;
  }));
  return paths.filter((p): p is string => p !== undefined);
}

interface WatchedRepo {
  normalizedRepoPath: string;
  isWorktree?: boolean;
  commonDir?: string;
}

/**
 * Notices `git worktree add` / `remove` for every discovered repo by watching
 * `<common>/worktrees/`. VS Code's git extension opens new worktrees only with
 * `git.detectWorktrees` on (off by default), so its open/close events can't be
 * the only trigger.
 */
export class WorktreeWatcher implements vscode.Disposable {
  private readonly watchers = new Map<string, vscode.Disposable>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly subscription: vscode.Disposable;

  constructor(private readonly deps: {
    onReposReady: vscode.Event<void>;
    areReposReady(): boolean;
    getRepos(): readonly WatchedRepo[];
    getWorkspaceRoots(): string[];
    scheduleRediscovery(reason: string): void;
  }) {
    this.subscription = deps.onReposReady(() => this.sync());
  }

  private sync(): void {
    const commonDirs = new Set(this.deps.getRepos().map(r => r.commonDir).filter((d): d is string => !!d));
    for (const [dir, watcher] of this.watchers) {
      if (!commonDirs.has(dir)) {
        watcher.dispose();
        this.watchers.delete(dir);
      }
    }
    for (const dir of commonDirs) {
      if (this.watchers.has(dir)) { continue; }
      // `worktrees/*` contains a `/`, so VS Code watches recursively and applies
      // files.watcherExclude, which keeps `.git/objects` out by default.
      // `worktrees` itself is included because the first `git worktree add` creates it and
      // its entry together: on Linux, the entry can land before the new folder is watched.
      // `check` reads the folder from disk, so the folder's own create event is enough.
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dir), "{worktrees,worktrees/*}"), false, true, false);
      watcher.onDidCreate(() => this.schedule(dir));
      watcher.onDidDelete(() => this.schedule(dir));
      this.watchers.set(dir, watcher);
      log(`Watching ${dir}/worktrees for added or removed worktrees`);
    }
  }

  // `git worktree add` writes several files; wait for them before reading.
  private schedule(commonDir: string): void {
    clearTimeout(this.timers.get(commonDir));
    this.timers.set(commonDir, setTimeout(() => {
      this.timers.delete(commonDir);
      void this.check(commonDir);
    }, 300));
  }

  private async check(commonDir: string): Promise<void> {
    // A rediscovery is already running and will read the disk itself.
    if (!this.deps.areReposReady()) { return; }
    const listed = await listLiveWorktrees(commonDir);
    const known = this.deps.getRepos()
      .filter(r => r.isWorktree && r.commonDir === commonDir)
      .map(r => r.normalizedRepoPath);
    const { added, removed } = diffWorktrees({
      listed,
      known,
      workspaceRoots: this.deps.getWorkspaceRoots().map(normalizePath),
      caseInsensitive: process.platform === "win32",
    });
    if (added.length === 0 && removed.length === 0) { return; }
    this.deps.scheduleRediscovery(
      `worktrees changed under ${commonDir}` +
      (added.length ? `, added ${added.join(", ")}` : "") +
      (removed.length ? `, removed ${removed.join(", ")}` : ""));
  }

  dispose(): void {
    this.subscription.dispose();
    for (const watcher of this.watchers.values()) { watcher.dispose(); }
    this.watchers.clear();
    for (const timer of this.timers.values()) { clearTimeout(timer); }
    this.timers.clear();
  }
}
