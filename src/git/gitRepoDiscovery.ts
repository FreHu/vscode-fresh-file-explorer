import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";

import { log } from "../extension/logger";
import { AbsolutePath, asAbsolutePath } from "../pathTypes";
import { execGitWithArgs, gitProbeSucceeds, fileExists } from "./gitOperations";
import { ConfigService } from "../config/configService";

/**
 * Check if a directory is at-or-below a git repository.
 *
 * NOTE: this is a "walk-up" check — `git rev-parse --git-dir` succeeds from any
 * subdirectory of a repo, including an UNINITIALIZED submodule dir (git resolves
 * to the superproject's .git). To ask "is THIS dir a repo root?" use
 * `isGitRepositoryRoot` instead — otherwise empty submodule dirs read as repos
 * and every git command run there silently targets the parent superproject.
 */
export async function isGitRepository(dirPath: string): Promise<boolean> {
  return gitProbeSucceeds(["rev-parse", "--git-dir"], dirPath);
}

/**
 * Check if a directory is itself a git repository ROOT (not merely a subdir of one).
 *
 * Uses `git rev-parse --show-prefix`, which returns the path from the repo root to
 * the cwd: empty string ⟺ cwd is the root. An uninitialized submodule dir resolves
 * to the superproject and returns a non-empty prefix (e.g. "third_party/foo/"), so
 * it is correctly rejected. Throws (→ false) when there is no repo at or above the dir.
 */
export async function isGitRepositoryRoot(dirPath: string): Promise<boolean> {
  try {
    const prefix = await execGitWithArgs(["rev-parse", "--show-prefix"], dirPath, { timeout: ConfigService.getGitTimeoutMs() });
    return prefix.trim() === "";
  } catch {
    return false;
  }
}

/**
 * Parse a .gitmodules file and return the relative paths of all submodules.
 * Returns an empty array if no .gitmodules file exists or it cannot be read.
 */
export async function readGitModulesSubmodulePaths(repoPath: string): Promise<string[]> {
  const gitModulesPath = path.join(repoPath, ".gitmodules");
  let content: string;
  try {
    content = await fs.promises.readFile(gitModulesPath, "utf-8");
  } catch {
    return [];
  }

  const paths: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*path\s*=\s*(.+)\s*$/);
    if (match) {
      paths.push(match[1].trim());
    }
  }

  log(`Found ${paths.length} submodule(s) in ${repoPath}: ${paths.join(", ")}`);
  return paths;
}

/** What to do with a single directory entry while discovering repos. */
export type DiscoveryAction =
  | "skip" // not a candidate (non-dir, dotdir, node_modules) — ignore entirely
  | "add" // a git repository root — record it, do not recurse
  | "skip-broken" // has a .git entry but git rejects it (e.g. moved worktree) — skip, do not recurse
  | "recurse"; // ordinary directory — descend to find nested repos

/**
 * Pure decision for a single directory entry during repo discovery.
 *
 * A `.git` entry (a directory for normal clones, a *file* for worktrees and submodules) marks a
 * git boundary: never recurse past it, even when git refuses to recognize it. The motivating bug —
 * a linked worktree whose `.git` gitdir pointer goes stale after its working tree is moved to a new
 * parent folder: `git rev-parse` then fails, and the old behavior fell through to recursing the
 * worktree's entire subtree. We are now able to detect this scenario and offer a fix to the user.
 *
 * `gitRecognizesRepo` is only meaningful when `hasGitEntry` is true; the caller may pass `false`
 * otherwise (the recurse/skip branches never read it) to avoid spawning git when there is no
 * `.git` to validate.
 */
export function classifyDiscoveryEntry(opts: {
  isDirectory: boolean;
  name: string;
  hasGitEntry: boolean;
  gitRecognizesRepo: boolean;
}): DiscoveryAction {
  const { isDirectory, name, hasGitEntry, gitRecognizesRepo } = opts;
  // node_modules is never a repo and is enormous — skipping it avoids a pointless deep fs walk.
  if (!isDirectory || name.startsWith(".") || name === "node_modules") {
    return "skip";
  }
  if (hasGitEntry) {
    return gitRecognizesRepo ? "add" : "skip-broken";
  }
  return "recurse";
}

/**
 * Discover git repositories in subdirectories of a path, recursing into non-repo directories.
 * Stops recursing once a git repository (or any `.git` boundary) is found — repos inside repos,
 * and the contents of a broken/moved worktree, are not scanned.
 * @param rootPath The directory to scan
 * @param relativePrefix Internal: the path prefix accumulated during recursion (forward-slash separated)
 */
export interface DiscoveredRepos {
  /** Repo roots found, as paths relative to the scanned root (forward-slash separated). */
  repos: string[];
  /**
   * Directories that have a `.git` entry but which git refuses to recognize — most commonly a
   * linked worktree whose gitdir pointer went stale after the working tree was moved. Surfaced so
   * the UI can tell the user their setup is silently degraded (some repos didn't load) and hint at
   * `git worktree repair`, rather than the breakage living only in the log.
   */
  brokenWorktrees: string[];
}

export async function discoverGitReposInSubdirs(rootPath: string, relativePrefix: string = ""): Promise<DiscoveredRepos> {
  const repos: string[] = [];
  const brokenWorktrees: string[] = [];

  try {
    const entries = await fs.promises.readdir(rootPath, { withFileTypes: true });

    for (const entry of entries) {
      const isDirectory = entry.isDirectory();
      const subDirPath = path.join(rootPath, entry.name);

      // Cheap fs check first: only spawn a git probe when there is actually a `.git` to validate.
      // Previously every non-repo directory cost a `git rev-parse` spawn, which made deep trees
      // (node_modules) and broken worktrees crawl.
      const hasGitEntry = isDirectory && !entry.name.startsWith(".") && entry.name !== "node_modules"
        ? await fileExists(path.join(subDirPath, ".git"))
        : false;
      const gitRecognizesRepo = hasGitEntry ? await isGitRepository(subDirPath) : false;

      const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      const action = classifyDiscoveryEntry({ isDirectory, name: entry.name, hasGitEntry, gitRecognizesRepo });

      switch (action) {
        case "add":
          log(`Found Git repository in subdirectory: ${relativePath}`);
          repos.push(relativePath);
          break;
        case "skip-broken":
          log(
            `Skipping ${relativePath}: it has a .git entry but git does not recognize it as a repository ` +
              `(e.g. a worktree whose gitdir pointer is stale after being moved). Not recursing into it.`,
            "warn",
          );
          brokenWorktrees.push(relativePath);
          break;
        case "recurse": {
          const nested = await discoverGitReposInSubdirs(subDirPath, relativePath);
          repos.push(...nested.repos);
          brokenWorktrees.push(...nested.brokenWorktrees);
          break;
        }
        case "skip":
          break;
      }
    }
  } catch (error) {
    log(`Error scanning subdirectories: ${error}`, "error");
  }

  return { repos, brokenWorktrees };
}

export interface RepoInfo {
  name: string;
  path: AbsolutePath;
}

/**
 * Expand a list of workspace folders into the actual git repositories they
 * contain. If the folder root itself is a git repo it is used directly;
 * otherwise subdirectories are scanned recursively.
 */
export async function discoverReposInWorkspace(
  folders: readonly vscode.WorkspaceFolder[],
  totalFolders: number,
): Promise<RepoInfo[]> {
  const repos: RepoInfo[] = [];

  for (const folder of folders) {
    const folderPath = folder.uri.fsPath;
    const rootIsGit = await isGitRepository(folderPath);

    if (rootIsGit) {
      repos.push({ name: folder.name, path: asAbsolutePath(folderPath) });
    } else {
      const subRepos = await discoverGitReposInSubdirs(folderPath);
      for (const repoRelPath of subRepos.repos) {
        const repoFullPath = asAbsolutePath(`${folderPath}/${repoRelPath}`);
        const repoName = totalFolders > 1 ? `${folder.name}/${repoRelPath}` : repoRelPath;
        repos.push({ name: repoName, path: repoFullPath });
      }
    }
  }

  return repos;
}
