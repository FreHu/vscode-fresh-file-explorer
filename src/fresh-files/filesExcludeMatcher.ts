/**
 * VS Code `files.exclude` matching, reproduced as a pure, dependency-free predicate.
 *
 * WHY THIS EXISTS
 * The extension builds its tree from git output (status/log), never from the
 * filesystem, so it has no knowledge of the editor's `files.exclude` setting —
 * git happily reports tracked files the Explorer hides. To honor `files.exclude`
 * we have to match paths ourselves.
 *
 * FIDELITY
 * VS Code does NOT use minimatch/picomatch — it ships its own glob→RegExp engine
 * in `vs/base/common/glob.ts` (MIT). The segment builder below (`parseRegExp`,
 * `splitGlobAware`, `starsToRegExp`, `escapeRegExpCharacters`) is a faithful port
 * of that engine's core so our `*`, `?`, `**`, `{a,b}`, `[a-z]` semantics match
 * the Explorer exactly. The "trivia" fast-paths in the original are pure
 * performance optimizations and are intentionally omitted — they are
 * behaviourally equivalent to the general regex, and our match volume is tiny.
 *
 * THE ANCESTOR RULE (the one non-obvious bit)
 * In VS Code, a bare glob like `backend` matches ONLY the path `backend`, not
 * `backend/src/app.js` — the Explorer hides the subtree structurally, by pruning
 * the `backend` directory node during tree expansion. We have flat leaf paths and
 * no tree walk, so we reproduce that pruning: a path is excluded if a glob matches
 * the path itself OR any of its ancestor directory prefixes. This makes
 * `backend` hide `backend/src/app.js` (ancestor match) while keeping bare patterns
 * root-anchored — `*.log` still does NOT match `sub/x.log`, exactly like VS Code.
 *
 * NOT SUPPORTED (v1): sibling/`when`-clause excludes — the object-valued form
 * where a glob is hidden only when a sibling file exists. Such entries are skipped.
 */

const PATH_REGEX = "[/\\\\]"; // any slash or backslash
const NO_PATH_REGEX = "[^/\\\\]"; // any non-slash and non-backslash
const GLOBSTAR = "**";
const GLOB_SPLIT = "/";

/** Port of `escapeRegExpCharacters` from vs/base/common/strings.ts. */
function escapeRegExpCharacters(value: string): string {
  return value.replace(/[\\{}*+?|^$.[\]()]/g, "\\$&");
}

/** Port of `starsToRegExp` from vs/base/common/glob.ts. */
function starsToRegExp(starCount: number, isLastPattern?: boolean): string {
  switch (starCount) {
    case 0:
      return "";
    case 1:
      // 1 star: any number of non-separator chars (non-greedy).
      return `${NO_PATH_REGEX}*?`;
    default:
      // Globstar: spans path segments (non-greedy).
      return `(?:${PATH_REGEX}|${NO_PATH_REGEX}+${PATH_REGEX}${isLastPattern ? `|${PATH_REGEX}${NO_PATH_REGEX}+` : ""})*?`;
  }
}

/** Port of `splitGlobAware` from vs/base/common/glob.ts: split on `splitChar`
 *  but not inside `{...}` braces or `[...]` brackets. */
export function splitGlobAware(pattern: string, splitChar: string): string[] {
  if (!pattern) {
    return [];
  }

  const segments: string[] = [];
  let inBraces = false;
  let inBrackets = false;
  let curVal = "";

  for (const char of pattern) {
    switch (char) {
      case splitChar:
        if (!inBraces && !inBrackets) {
          segments.push(curVal);
          curVal = "";
          continue;
        }
        break;
      case "{":
        inBraces = true;
        break;
      case "}":
        inBraces = false;
        break;
      case "[":
        inBrackets = true;
        break;
      case "]":
        inBrackets = false;
        break;
    }
    curVal += char;
  }

  if (curVal) {
    segments.push(curVal);
  }

  return segments;
}

/** Port of `parseRegExp` from vs/base/common/glob.ts — converts a glob to the
 *  body of a regular expression (without anchors). */
function parseRegExp(pattern: string): string {
  if (!pattern) {
    return "";
  }

  let regEx = "";
  const segments = splitGlobAware(pattern, GLOB_SPLIT);

  if (segments.every(segment => segment === GLOBSTAR)) {
    regEx = ".*";
  } else {
    let previousSegmentWasGlobStar = false;
    segments.forEach((segment, index) => {
      if (segment === GLOBSTAR) {
        if (previousSegmentWasGlobStar) {
          return;
        }
        regEx += starsToRegExp(2, index === segments.length - 1);
      } else {
        let inBraces = false;
        let braceVal = "";
        let inBrackets = false;
        let bracketVal = "";

        for (const char of segment) {
          if (char !== "}" && inBraces) {
            braceVal += char;
            continue;
          }

          if (inBrackets && (char !== "]" || !bracketVal)) {
            let res: string;
            if (char === "-") {
              res = char;
            } else if ((char === "^" || char === "!") && !bracketVal) {
              res = "^";
            } else if (char === GLOB_SPLIT) {
              res = "";
            } else {
              res = escapeRegExpCharacters(char);
            }
            bracketVal += res;
            continue;
          }

          switch (char) {
            case "{":
              inBraces = true;
              continue;
            case "[":
              inBrackets = true;
              continue;
            case "}": {
              const choices = splitGlobAware(braceVal, ",");
              const braceRegExp = `(?:${choices.map(choice => parseRegExp(choice)).join("|")})`;
              regEx += braceRegExp;
              inBraces = false;
              braceVal = "";
              break;
            }
            case "]":
              regEx += "[" + bracketVal + "]";
              inBrackets = false;
              bracketVal = "";
              break;
            case "?":
              regEx += NO_PATH_REGEX;
              continue;
            case "*":
              regEx += starsToRegExp(1);
              continue;
            default:
              regEx += escapeRegExpCharacters(char);
          }
        }

        // Add the separator we split on if more segments follow and the next
        // isn't a trailing globstar — prevents `some/**` matching `something`.
        if (
          index < segments.length - 1 &&
          (segments[index + 1] !== GLOBSTAR || index + 2 < segments.length)
        ) {
          regEx += PATH_REGEX;
        }
      }

      previousSegmentWasGlobStar = segment === GLOBSTAR;
    });
  }

  return regEx;
}

/**
 * Normalize an exclude glob the way VS Code's `trimForExclusions` does, so that
 * `foo/**` and `foo/` both reduce to `foo` and are then handled by the
 * ancestor-prefix rule. (`foo/**` would also match `foo` via globstar directly;
 * normalizing keeps the regex set small and uniform.)
 */
function normalizeExcludeGlob(glob: string): string {
  let g = glob.trim();
  if (g.endsWith("/**")) {
    g = g.slice(0, -3);
  }
  if (g.endsWith("/")) {
    g = g.slice(0, -1);
  }
  return g;
}

export type ExcludePredicate = (relativePath: string) => boolean;

const NEVER_EXCLUDES: ExcludePredicate = () => false;

/** Glob metacharacters. A pattern with none of these is a plain literal path. */
const GLOB_META_REGEX = /[*?{}[\]]/;

/**
 * If `glob` is a basename-anywhere pattern (`**​/<literal>` with no further glob
 * metacharacters), return the literal segment; otherwise undefined. These are by
 * far the most common excludes (`**​/.git`, `**​/node_modules`, …) and reduce to a
 * cheap "is `<literal>` a path segment" test instead of the regex engine.
 */
function basenameGlobLiteral(glob: string): string | undefined {
  if (!glob.startsWith("**/")) {
    return undefined;
  }
  const rest = glob.slice(3);
  return rest && !GLOB_META_REGEX.test(rest) && !rest.includes("/") ? rest : undefined;
}

/**
 * Compile a `files.exclude` expression into a predicate over folder-relative
 * paths. Only entries whose value is exactly `true` are honored; `false` and
 * sibling/`when`-clause object values are skipped.
 *
 * The returned predicate tolerates either slash style and tests the path plus
 * each ancestor directory prefix (see the ANCESTOR RULE in the file header).
 *
 * Patterns are classified at compile time so the hot path avoids the regex
 * engine wherever possible — this matters because the predicate runs once per
 * file per render over potentially thousands of files:
 *   - `**​/<literal>` → the literal must appear as a whole path segment.
 *   - bare `<literal>` (no glob metachars) → the path equals it or descends from
 *     it (this is exactly the ancestor rule, with no split/loop).
 *   - anything else → the original regex + ancestor-prefix walk, taken only when
 *     at least one such pattern exists.
 * VS Code's own engine ships equivalent "trivia" fast paths; the default
 * `files.exclude` (`**​/.git`, `**​/.svn`, …) is entirely basename globs, so the
 * regex branch is never even entered.
 */
export function compileFilesExclude(
  expression: Record<string, unknown> | undefined,
): ExcludePredicate {
  if (!expression) {
    return NEVER_EXCLUDES;
  }

  const literals: string[] = []; // bare literal: match self + descendants
  const basenames: string[] = []; // `**/x`: match x as any whole segment (+ descendants)
  const regexes: RegExp[] = []; // general glob: regex + ancestor-prefix rule
  for (const [glob, value] of Object.entries(expression)) {
    if (value !== true) {
      continue; // skip disabled (false) and when-clause (object) entries
    }
    const normalized = normalizeExcludeGlob(glob);
    if (!normalized) {
      continue;
    }
    const basename = basenameGlobLiteral(normalized);
    if (basename) {
      basenames.push(basename);
      continue;
    }
    if (!GLOB_META_REGEX.test(normalized)) {
      literals.push(normalized);
      continue;
    }
    try {
      regexes.push(new RegExp(`^${parseRegExp(normalized)}$`));
    } catch {
      // Malformed glob — ignore rather than break the whole tree.
    }
  }

  if (literals.length === 0 && basenames.length === 0 && regexes.length === 0) {
    return NEVER_EXCLUDES;
  }

  return (relativePath: string): boolean => {
    let normalized = relativePath.indexOf("\\") === -1 ? relativePath : relativePath.replace(/\\/g, "/");
    // Trim leading/trailing slashes without regex (the common case is neither).
    let start = 0;
    let end = normalized.length;
    while (start < end && normalized[start] === "/") { start++; }
    while (end > start && normalized[end - 1] === "/") { end--; }
    if (start !== 0 || end !== normalized.length) {
      normalized = normalized.slice(start, end);
    }
    if (!normalized) {
      return false;
    }

    // Bare literal: path equals it or descends from it.
    for (const lit of literals) {
      if (normalized === lit || normalized.startsWith(lit + "/")) {
        return true;
      }
    }

    // `**/x`: x must appear as a whole path segment.
    if (basenames.length > 0) {
      const wrapped = `/${normalized}/`;
      for (const b of basenames) {
        if (wrapped.includes(`/${b}/`)) {
          return true;
        }
      }
    }

    // General globs: test the full path and every ancestor directory prefix.
    if (regexes.length > 0) {
      const segments = normalized.split("/");
      let prefix = "";
      for (let i = 0; i < segments.length; i++) {
        prefix = i === 0 ? segments[0] : `${prefix}/${segments[i]}`;
        for (const re of regexes) {
          if (re.test(prefix)) {
            return true;
          }
        }
      }
    }
    return false;
  };
}
