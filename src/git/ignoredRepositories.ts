import * as path from "path";
import { normalizePath } from "../pathTypes";

/**
 * Whether `repoRoot` is listed in `git.ignoredRepositories`, matched the way
 * VS Code's git extension does (`Model.shouldRepositoryBeIgnored`): the entry
 * names the root itself, not a parent folder; an absolute entry is compared
 * directly and a relative one against each workspace folder; case-insensitive
 * on Windows and macOS; a trailing separator doesn't matter.
 */
export function isIgnoredRepository(opts: {
  repoRoot: string;
  ignored: readonly string[];
  workspaceFolders: readonly string[];
  caseInsensitive: boolean;
}): boolean {
  const norm = (p: string) => {
    const n = path.posix.normalize(normalizePath(p)).replace(/(.)\/$/, "$1");
    return opts.caseInsensitive ? n.toLowerCase() : n;
  };
  const isAbsolute = (p: string) => /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p);
  const root = norm(opts.repoRoot);
  return opts.ignored.some(entry => isAbsolute(entry)
    ? norm(entry) === root
    : opts.workspaceFolders.some(folder => norm(`${folder}/${entry}`) === root));
}
