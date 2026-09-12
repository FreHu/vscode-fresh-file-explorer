import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { manifestDir } from "../manifest";

// Drift check for the agent-facing docs: CLAUDE.md is a nav aid, so a wrong
// path — or a symbol attributed to the wrong file — is worse than no claim at
// all, because it sends a reader (human or LLM) confidently to the wrong
// place. Runs in the host-free unit tier: plain `fs`, no vscode API.

const DOCS = ["CLAUDE.md"];

/** Paths naming sources outside this repo (e.g. vscode's own tree). */
const EXTERNAL_PATHS = new Set(["vs/base/common/glob.ts"]);

const root = manifestDir();

/** Every .ts/.mjs file under the source dirs, indexed by basename. */
function sourceIndex(): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(rel);
      } else if (/\.(ts|mjs)$/.test(entry.name)) {
        const existing = index.get(entry.name);
        if (existing) {
          existing.push(rel);
        } else {
          index.set(entry.name, [rel]);
        }
      }
    }
  };
  for (const dir of ["src", "scripts"]) {
    if (fs.existsSync(path.join(root, dir))) {
      walk(dir);
    }
  }
  return index;
}

const index = sourceIndex();

/**
 * Resolve a doc-mentioned file reference to a repo-relative path. Accepts an
 * explicit path (`src/git/gitLogStream.ts`) or a bare basename
 * (`gitOperations.ts`) when that basename is unambiguous.
 */
function resolveRef(ref: string): { path?: string; reason?: string } {
  if (ref.includes("/")) {
    return fs.existsSync(path.join(root, ref)) ? { path: ref } : { reason: "no such file" };
  }
  const hits = index.get(ref);
  if (!hits || hits.length === 0) {
    // Root-level files (package.json, tsconfig.json) are named bare too.
    if (fs.existsSync(path.join(root, ref))) {
      return { path: ref };
    }
    return { reason: "no file with this name at the repo root, or under src/ or scripts/" };
  }
  if (hits.length > 1) {
    return { reason: `ambiguous basename, matches ${hits.join(", ")}` };
  }
  return { path: hits[0] };
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;
const IDENT_SPLIT = /[^A-Za-z0-9_$]+/;
const DECL_KEYWORDS = new Set(["function", "class", "const", "let", "var", "interface", "type", "enum"]);
/** What may follow a member/property declaration name. */
const MEMBER_FOLLOW = new Set(["(", "=", ":", "<"]);

/**
 * Is `symbol` declared in the file at `relPath`?
 *
 * Two forms are recognised. The keyword form (`export function foo`) is exact,
 * and is what catches the misattributed-export bug this suite exists for. The
 * member form (`static forRepository(`) is deliberately lenient: it cannot
 * distinguish a declaration from a bare call of an imported name, so it can
 * pass a claim it ought to fail. Dotted call sites are excluded, which removes
 * the common false positive.
 */
function declares(relPath: string, symbol: string, keywordOnly = false): boolean {
  const source = fs.readFileSync(path.join(root, relPath), "utf8");
  // Dotted references are satisfied by the member name — statics and methods
  // have no standalone declaration keyword.
  const name = symbol.split(".").pop() as string;

  for (const raw of source.split("\n")) {
    const line = raw.trim();
    const at = line.indexOf(name);
    if (at < 0) {
      continue;
    }

    const tokens = line.split(IDENT_SPLIT).filter(Boolean);
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i] === name && DECL_KEYWORDS.has(tokens[i - 1])) {
        return true;
      }
    }
    if (keywordOnly) {
      continue;
    }

    const before = at === 0 ? "" : line[at - 1];
    if (before === "." || IDENT_CHAR.test(before)) {
      continue;
    }
    const after = line.slice(at + name.length).trimStart();
    if (after.length > 0 && MEMBER_FOLLOW.has(after[0])) {
      return true;
    }
  }
  return false;
}

interface Claim {
  symbol: string;
  ref: string;
}

/** A link label that is itself a filename names no symbol. */
const FILENAME_LABEL = /\.(?:ts|mjs|md|json)$/;
/** Words that make a `Symbol` ... `file.ts` pair an actual attribution. */
const ATTRIBUTION = /\b(?:in|to|from|inside|within)\b/;

/** Matches `[`Symbol`](src/path/file.ts)` and the prose form `Symbol` in `file.ts`. */
function extractClaims(text: string): Claim[] {
  const claims: Claim[] = [];
  const link = /\[`?([A-Za-z_][A-Za-z0-9_.]*)`?\]\(([^)]+\.(?:ts|mjs))\)/g;
  for (let m = link.exec(text); m; m = link.exec(text)) {
    if (!FILENAME_LABEL.test(m[1])) {
      claims.push({ symbol: m[1], ref: m[2] });
    }
  }
  // Line-scoped, and the gap must read as an attribution — otherwise adjacent
  // backticked tokens either side of a heading pair up into a phantom claim.
  for (const line of text.split("\n")) {
    const prose = /`([A-Za-z_][A-Za-z0-9_.]*)`([^`]{0,40}?)`([A-Za-z0-9_./-]+\.(?:ts|mjs))`/g;
    for (let m = prose.exec(line); m; m = prose.exec(line)) {
      if (!FILENAME_LABEL.test(m[1]) && ATTRIBUTION.test(m[2])) {
        claims.push({ symbol: m[1], ref: m[3] });
      }
    }
  }
  return claims;
}

/** Every repo-relative path a doc points at, code-labelled or not. */
function extractPaths(text: string): string[] {
  const found: string[] = [];
  const link = /\[[^\]]*\]\(([^)#]+)\)/g;
  for (let m = link.exec(text); m; m = link.exec(text)) {
    const target = m[1].trim();
    if (!/^[a-z]+:/.test(target) && !target.startsWith("#")) {
      found.push(target);
    }
  }
  const backticked = /`([a-zA-Z0-9_./-]+\.(?:ts|mjs|md|json))`/g;
  for (let m = backticked.exec(text); m; m = backticked.exec(text)) {
    found.push(m[1]);
  }
  return found;
}

suite("Docs ↔ source drift", () => {
  for (const doc of DOCS) {
    // Read inside each test: a miss (e.g. wrong casing on a case-sensitive FS)
    // must fail this test, not abort the whole unit run at collection time.
    const read = (): string => fs.readFileSync(path.join(root, doc), "utf8");

    test(`${doc}: every referenced file exists`, () => {
      const text = read();
      const broken: string[] = [];
      for (const ref of new Set(extractPaths(text))) {
        if (EXTERNAL_PATHS.has(ref)) {
          continue;
        }
        const resolved = resolveRef(ref);
        if (!resolved.path) {
          broken.push(`${ref} — ${resolved.reason}`);
        }
      }
      assert.deepStrictEqual(broken, [], `${doc} references files that do not exist:\n  ${broken.join("\n  ")}`);
    });

    test(`${doc}: every "symbol lives in file" claim is true`, () => {
      const text = read();
      const wrong: string[] = [];
      for (const claim of extractClaims(text)) {
        if (EXTERNAL_PATHS.has(claim.ref)) {
          continue;
        }
        const resolved = resolveRef(claim.ref);
        if (!resolved.path) {
          continue; // already reported by the path test
        }
        if (!declares(resolved.path, claim.symbol)) {
          // Keyword form only for the hint — the lenient member form would
          // point at call sites, which is worse than no suggestion.
          const elsewhere = [...index.values()]
            .flat()
            .filter(p => declares(p, claim.symbol, true))
            .slice(0, 3);
          wrong.push(
            `claims \`${claim.symbol}\` is in ${resolved.path}` +
              (elsewhere.length ? ` — actually declared in ${elsewhere.join(", ")}` : " — not found anywhere"),
          );
        }
      }
      assert.deepStrictEqual(wrong, [], `${doc} misattributes symbols:\n  ${wrong.join("\n  ")}`);
    });
  }
});
