/**
 * The line predicate shared by diff search's two filtering paths (streaming
 * file lines, and post-filtering diff matches git could not pickaxe itself).
 *
 * Kept in its own vscode-free module so it is unit-testable in the fast tier —
 * diffSearchParser pulls in the logger and ConfigService, and therefore vscode.
 */

/**
 * Build the line predicate for a search: regex, case-insensitive substring, or
 * exact substring.
 *
 * A factory rather than a `matches(line, pattern, …)` call so the
 * case-insensitive branch lowercases the pattern once instead of once per
 * line — the shape both original copies had, and the reason not to inline it.
 *
 * `regex` wins when present; callers compile it with the `i` flag themselves
 * when the search is case-insensitive, so `caseInsensitive` only governs the
 * substring branches.
 */
export function createLineMatcher(
  pattern: string,
  regex: RegExp | null,
  caseInsensitive: boolean,
): (line: string) => boolean {
  if (regex) {
    return line => regex.test(line);
  }
  if (caseInsensitive) {
    const lowerPattern = pattern.toLowerCase();
    return line => line.toLowerCase().includes(lowerPattern);
  }
  return line => line.includes(pattern);
}
