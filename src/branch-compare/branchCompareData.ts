import * as path from "path";

import { COMMIT_NAME_STATUS_PRETTY, execGitWithArgs, streamGitDiffNumstat, streamGitLogNameStatus } from "../git/gitOperations";
import { ConfigService } from "../config/configService";
import { decodeGitPath } from "../git/gitOperations";
import { AbsolutePath, asAbsolutePath } from "../pathTypes";
import { normalizePath } from "../utils";
import { CommitData } from "../types";

/**
 * Status code for a single file in a branch comparison.
 *
 * - `A` added (vs baseline)
 * - `M` modified
 * - `D` deleted (file existed at baseline, gone in HEAD or working tree)
 * - `R` renamed (committed only — working-tree renames are reported as add+delete pair)
 * - `T` type change (e.g. file ↔ symlink)
 * - `U` untracked working-tree file (not in baseline either; only relevant when working-tree overlay is on)
 */
export type ChangeStatus = "A" | "M" | "D" | "R" | "T" | "U";

export interface ChangedFile {
  /** Repo this entry belongs to (forward-slash absolute path). */
  repoFullPath: AbsolutePath;
  /** Path inside the repo, forward slashes, no leading slash. */
  pathInRepo: string;
  /** Absolute filesystem path, forward slashes. */
  absolutePath: AbsolutePath;
  status: ChangeStatus;
  /** Source path for renames (committed-only). Undefined otherwise. */
  renameSource?: string;
  /** True when the entry came from the working-tree status, not the committed range. */
  isPending: boolean;
  /**
   * The most recent commit in the branch range that touched this file.
   * Undefined for purely-pending entries (the change is uncommitted) and for
   * entries fetched without commit info (when grouping mode doesn't need it).
   */
  commit?: CommitData;
  /**
   * Working-tree line deltas, set ONLY for pending entries (from the cheap
   * `git diff --numstat HEAD`). Historical entries never carry these — counting
   * lines across a commit range needs content diffs, which were deliberately
   * dropped from the historical path for performance. Untracked files have no
   * counts (they aren't in the HEAD diff).
   */
  linesAdded?: number;
  linesDeleted?: number;
}

/**
 * Normalize a single status letter from `git diff --name-status -z`.
 * `R100`, `R75`, `C50`, etc. collapse to the bare letter.
 */
function parseDiffStatusLetter(raw: string): ChangeStatus | undefined {
  if (!raw) return undefined;
  const letter = raw[0];
  switch (letter) {
    case "A":
    case "M":
    case "D":
    case "T":
      return letter;
    case "R":
    case "C":
      return "R"; // treat copies as renames for display purposes
    default:
      return undefined;
  }
}

/**
 * Parse output of `git diff --name-status -z <range>`.
 *
 * Format with `-z`: NUL-delimited fields. Each entry is either two fields
 * (`status\0path\0`) or three fields for renames/copies (`R<n>\0src\0dst\0`).
 *
 * Returns committed-side ChangedFile records (without repo/abs paths filled in —
 * caller layers those on, since the parser is pure).
 */
export function parseDiffNameStatusZ(output: string): Array<{
  status: ChangeStatus;
  pathInRepo: string;
  renameSource?: string;
}> {
  if (!output) return [];
  // Drop the trailing NUL if present so we don't get a phantom empty entry.
  const fields = output.endsWith("\0")
    ? output.slice(0, -1).split("\0")
    : output.split("\0");
  const out: Array<{ status: ChangeStatus; pathInRepo: string; renameSource?: string }> = [];

  let i = 0;
  while (i < fields.length) {
    const raw = fields[i++];
    if (!raw) continue; // skip stray empty fields
    const status = parseDiffStatusLetter(raw);
    if (!status) {
      // Unknown status — skip the path field too so we don't desync.
      if (i < fields.length) { i++; }
      continue;
    }
    if (status === "R") {
      // Rename / copy → consume two paths.
      const src = fields[i++];
      const dst = fields[i++];
      if (src && dst) {
        out.push({ status, pathInRepo: decodeGitPath(dst), renameSource: decodeGitPath(src) });
      }
    } else {
      const p = fields[i++];
      if (p) {
        out.push({ status, pathInRepo: decodeGitPath(p) });
      }
    }
  }
  return out;
}

/**
 * Parse output of `git status --porcelain=v1 -z`.
 *
 * Format with `-z`: each entry is `XY<space>path\0`, except renames (`R`) /
 * copies (`C`) where the path field is two NUL-separated paths
 * (`XY<space>new\0old`).
 *
 * `XY` = index status, worktree status. Either may be space (unchanged on
 * that side). Untracked = `??`, ignored = `!!` (filtered out).
 *
 * Returns one entry per file with the resolved status letter relative to a
 * baseline-mode comparison: anything modified on either side becomes "M",
 * untracked → "U", deletions → "D", renames → "R" with the source path.
 */
export function parseStatusPorcelainZ(output: string): Array<{
  status: ChangeStatus;
  pathInRepo: string;
  renameSource?: string;
}> {
  if (!output) return [];
  const stripped = output.endsWith("\0") ? output.slice(0, -1) : output;
  if (!stripped) return [];

  const out: Array<{ status: ChangeStatus; pathInRepo: string; renameSource?: string }> = [];
  // Split into entries. `git status -z` emits `XY<space>path\0`, or for
  // renames/copies `XY<space>new\0old\0`. We need a small state machine.
  const fields = stripped.split("\0");
  let i = 0;
  while (i < fields.length) {
    const entry = fields[i++];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    // entry[2] is the space separator; the path begins at index 3.
    const pathField = entry.slice(3);

    if (xy === "!!") {
      // ignored — skip (rename source still needs to be consumed if present)
      continue;
    }
    if (xy === "??") {
      // A trailing slash on an untracked entry means git refused to descend into
      // a nested git boundary (worktree / submodule / nested repo). With `-uall`
      // ordinary untracked dirs are already expanded to files, so this is never a
      // plain directory — drop it so nested worktrees don't appear as phantom
      // changed files.
      const p = decodeGitPath(pathField);
      if (!p.endsWith("/")) {
        out.push({ status: "U", pathInRepo: p });
      }
      continue;
    }

    const x = xy[0];
    const y = xy[1];
    let renameSource: string | undefined;
    // Renames / copies: a second field follows with the original path. The
    // marker can be in either column (index rename: R*, worktree rename: *R).
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const src = fields[i++];
      if (src) {
        renameSource = decodeGitPath(src);
      }
    }

    let status: ChangeStatus;
    if (x === "D" || y === "D") {
      status = "D";
    } else if (renameSource) {
      status = "R";
    } else if (x === "A" || y === "A") {
      status = "A";
    } else if (x === "T" || y === "T") {
      status = "T";
    } else {
      // M, U (unmerged), and any other change → modified.
      status = "M";
    }
    if (renameSource !== undefined) {
      out.push({ status, pathInRepo: decodeGitPath(pathField), renameSource });
    } else {
      out.push({ status, pathInRepo: decodeGitPath(pathField) });
    }
  }
  return out;
}

/**
 * Run `git diff --name-status -z mergeBase..source` for the repo and return
 * parsed entries (without repo/abs paths — see {@link buildChangedFiles} for
 * the layered structure).
 *
 * `source` defaults to `"HEAD"`. Pass an explicit ref name when comparing two
 * arbitrary refs (e.g. `v1.4..v1.2`).
 */
export async function fetchCommittedDiff(
  repoFullPath: string,
  mergeBaseSha: string,
  source: string = "HEAD",
): Promise<Array<{ status: ChangeStatus; pathInRepo: string; renameSource?: string }>> {
  const args = ["diff", "--name-status", "-z", `${mergeBaseSha}..${source}`];
  const out = await execGitWithArgs(args, repoFullPath, { timeout: ConfigService.getGitTimeoutMs() });
  return parseDiffNameStatusZ(out);
}

/**
 * For ancestrally-related refs (target is an ancestor of source — typically
 * `HEAD~N` against `HEAD`), the diff between them is `mergeBase..source` and
 * includes everything reachable from source-but-not-target via the full DAG.
 * If `source` contains merges, that cone can be much wider than the visible
 * first-parent walk — surprising for users who treat `HEAD~5` as "my last 5
 * commits."
 *
 * Returns the two counts so the UI can surface the gap. Two `git rev-list
 * --count` calls — both cheap. Returns `undefined` on failure (don't block
 * the refresh on a hint).
 */
export async function fetchMergeConeStats(
  repoFullPath: string,
  mergeBaseSha: string,
  source: string,
): Promise<{ total: number; firstParent: number } | undefined> {
  try {
    const range = `${mergeBaseSha}..${source}`;
    const [totalOut, fpOut] = await Promise.all([
      execGitWithArgs(["rev-list", "--count", range], repoFullPath, {
        timeout: ConfigService.getGitTimeoutMs(),
      }),
      execGitWithArgs(["rev-list", "--count", "--first-parent", range], repoFullPath, {
        timeout: ConfigService.getGitTimeoutMs(),
      }),
    ]);
    const total = parseInt(totalOut.trim(), 10);
    const firstParent = parseInt(fpOut.trim(), 10);
    if (Number.isNaN(total) || Number.isNaN(firstParent)) { return undefined; }
    return { total, firstParent };
  } catch {
    return undefined;
  }
}

/** Run `git status --porcelain=v1 -z -uall` and parse it. */
export async function fetchWorkingTreeStatus(
  repoFullPath: string,
): Promise<Array<{ status: ChangeStatus; pathInRepo: string; renameSource?: string }>> {
  // `-uall` expands untracked directories into individual files. Without it an
  // untracked dir collapses to `dir/` and can't be told apart from a nested git
  // boundary (worktree/submodule/nested repo), which git also reports as `dir/`.
  // With it, a surviving trailing-slash `??` entry is unambiguously a boundary
  // and parseStatusPorcelainZ drops it (see there) — otherwise a worktree nested
  // in the repo shows up as a phantom changed "file".
  const args = ["status", "--porcelain=v1", "-z", "-uall"];
  const out = await execGitWithArgs(args, repoFullPath, { timeout: ConfigService.getGitTimeoutMs() });
  return parseStatusPorcelainZ(out);
}

/**
 * Working-tree line deltas from `git diff --numstat HEAD` (staged + unstaged
 * tracked changes), keyed by normalized repo-relative path. Cheap — it diffs
 * only the working tree against HEAD, never a commit range. Untracked files are
 * absent (they aren't in the HEAD diff), so they carry no counts.
 */
export async function fetchWorkingTreeNumstat(
  repoFullPath: string,
): Promise<Map<string, { added: number; deleted: number }>> {
  const raw = await streamGitDiffNumstat(
    ["diff", "--numstat", "HEAD"],
    repoFullPath,
    ConfigService.getGitTimeoutMs(),
  );
  // Normalize keys so they match ChangedFile.pathInRepo lookups.
  const normalized = new Map<string, { added: number; deleted: number }>();
  for (const [p, counts] of raw) {
    normalized.set(normalizePath(p), counts);
  }
  return normalized;
}

/**
 * For every file changed between `mergeBaseSha` and HEAD, return its most
 * recent commit (author / date / hash / message). Used by grouping modes
 * Author / Commit Hash / Moon Phase / Retrograde — none of which work
 * without per-file commit metadata.
 *
 * Streams `git log --name-status` so memory stays bounded for large branches.
 * Path keys are forward-slash repo-relative paths matching `ChangedFile.pathInRepo`.
 */
export async function fetchCommitInfoInRange(
  repoFullPath: string,
  mergeBaseSha: string,
  source: string = "HEAD",
): Promise<Map<string, CommitData>> {
  const args = [
    "log",
    "--name-status",
    "--author-date-order",
    COMMIT_NAME_STATUS_PRETTY,
    `${mergeBaseSha}..${source}`,
  ];
  const fileMap = await streamGitLogNameStatus(
    args,
    repoFullPath,
    "",
    ConfigService.getGitTimeoutMs(),
    undefined,
    ConfigService.getAiCoAuthorEmails(),
  );
  // streamGitLogNameStatus already keeps the first occurrence per file (newest
  // commit, since git log streams newest-first), which is what we want.
  const out = new Map<string, CommitData>();
  for (const [pathInRepo, entry] of fileMap.entries()) {
    out.set(normalizePath(pathInRepo), entry.commit);
  }
  return out;
}

/**
 * Merge committed-range entries with working-tree status entries into the
 * canonical `ChangedFile[]` shape used by the tree provider.
 *
 * Precedence rules:
 * - If a path appears in working-tree status it is reported with `isPending: true`
 *   regardless of any committed entry (the working tree is the more recent state).
 * - Otherwise the committed entry is used as-is.
 *
 * `commitInfo` (optional) is layered onto committed entries by repo-relative
 * path. Working-tree entries don't get commit info — the change is uncommitted.
 * For renames, the **destination** path is the lookup key, matching what
 * `fetchCommitInfoInRange` produces.
 *
 * Pure function — fully testable without git.
 */
export function buildChangedFiles(
  repoFullPath: AbsolutePath,
  committed: Array<{ status: ChangeStatus; pathInRepo: string; renameSource?: string }>,
  workingTree: Array<{ status: ChangeStatus; pathInRepo: string; renameSource?: string }>,
  commitInfo?: Map<string, CommitData>,
  /** Working-tree line deltas keyed by repo-relative path. Applied to pending entries only. */
  workingTreeNumstat?: Map<string, { added: number; deleted: number }>,
): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();

  const join = (p: string): AbsolutePath =>
    asAbsolutePath(path.join(repoFullPath, p));

  for (const entry of committed) {
    const key = entry.pathInRepo;
    const normalizedPath = normalizePath(entry.pathInRepo);
    byPath.set(key, {
      repoFullPath,
      pathInRepo: normalizedPath,
      absolutePath: join(entry.pathInRepo),
      status: entry.status,
      renameSource: entry.renameSource ? normalizePath(entry.renameSource) : undefined,
      isPending: false,
      commit: commitInfo?.get(normalizedPath),
    });
  }

  for (const entry of workingTree) {
    const key = entry.pathInRepo;
    const normalizedPath = normalizePath(entry.pathInRepo);
    const counts = workingTreeNumstat?.get(normalizedPath);
    byPath.set(key, {
      repoFullPath,
      pathInRepo: normalizedPath,
      absolutePath: join(entry.pathInRepo),
      status: entry.status,
      renameSource: entry.renameSource ? normalizePath(entry.renameSource) : undefined,
      isPending: true,
      linesAdded: counts?.added,
      linesDeleted: counts?.deleted,
    });
  }

  // Stable sort by path keeps tests deterministic and the tree predictable.
  return [...byPath.values()].sort((a, b) => a.pathInRepo.localeCompare(b.pathInRepo));
}

// ── Folder tree shaping ────────────────────────────────────────────────────────

export interface FolderNode {
  /** Path relative to the repo root, forward slashes. Empty string for the repo root. */
  pathInRepo: string;
  /** Just the basename (display label). Empty string at the repo root. */
  name: string;
  children: Map<string, FolderNode>;
  files: ChangedFile[];
}

/**
 * Group changed files into a folder tree rooted at the repo root. Folders
 * never appear without a descendant file — empty branches are pruned.
 *
 * Pure function.
 */
export function buildFolderTree(files: ChangedFile[]): FolderNode {
  const root: FolderNode = {
    pathInRepo: "",
    name: "",
    children: new Map(),
    files: [],
  };

  for (const file of files) {
    const parts = file.pathInRepo.split("/").filter(Boolean);
    if (parts.length === 0) {
      // Defensive: an empty path shouldn't happen. Skip it.
      continue;
    }
    let cursor = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i];
      let child = cursor.children.get(segment);
      if (!child) {
        const childPath = cursor.pathInRepo ? `${cursor.pathInRepo}/${segment}` : segment;
        child = { pathInRepo: childPath, name: segment, children: new Map(), files: [] };
        cursor.children.set(segment, child);
      }
      cursor = child;
    }
    cursor.files.push(file);
  }

  return root;
}

/** Total file count in a subtree (for badges on folder nodes). */
export function countFilesIn(node: FolderNode): number {
  let total = node.files.length;
  for (const child of node.children.values()) {
    total += countFilesIn(child);
  }
  return total;
}

/** Flat list of every file in a folder subtree (depth-first, sorted by path). */
export function collectFilesIn(node: FolderNode): ChangedFile[] {
  const out: ChangedFile[] = [];
  const walk = (n: FolderNode) => {
    out.push(...n.files);
    for (const child of n.children.values()) {
      walk(child);
    }
  };
  walk(node);
  return out.sort((a, b) => a.pathInRepo.localeCompare(b.pathInRepo));
}
