import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { parseDiffOutput, filterMatchesByPattern, isGitRegexError, buildHistoricalSearchArgs } from "../../diff-search/diffSearchParser";

const fixture = fs.readFileSync(path.join(__dirname, "..", "fixtures", "pickaxe.txt"), "utf-8");
const CWD = "/repo";

suite("parseDiffOutput - pickaxe fixture (git log -p -S delete)", () => {
  const all = parseDiffOutput(fixture, CWD, true);
  const matches = filterMatchesByPattern(all, "delete", null, false);

  test("1 commit parsed", () => {
    const commits = new Set(matches.map(m => m.commitHash));
    assert.strictEqual(commits.size, 1);
    assert.ok([...commits][0]?.startsWith("ccdbfbb"));
  });

  test("12 total matches", () => {
    assert.strictEqual(matches.length, 12);
  });

  test("9 additions, 3 removals", () => {
    assert.strictEqual(matches.filter(m => m.changeType === "added").length, 9);
    assert.strictEqual(matches.filter(m => m.changeType === "removed").length, 3);
  });

  test("6 distinct files", () => {
    const files = new Set(matches.map(m => m.filePath));
    assert.strictEqual(files.size, 6);
  });

  test("commit message is '1.1'", () => {
    assert.ok(matches.every(m => m.commitMessage === "1.1"));
  });

  test("commit date is 2026", () => {
    assert.ok(matches.every(m => m.commitDate?.getFullYear() === 2026));
  });
});

suite("isGitRegexError - distinguishes git ERE compile failures from other output", () => {
  // Real stderr strings from `git log -G <pattern>` (git always prefixes "invalid regex").
  const gitRegexErrors = [
    "fatal: invalid regex: Invalid back reference",
    "fatal: invalid regex: Unmatched ( or \\(",
    "fatal: invalid regex: Unmatched \\{",
    "fatal: invalid regex: Invalid range end",
    "fatal: invalid regex: Invalid preceding regular expression",
  ];

  for (const stderr of gitRegexErrors) {
    test(`detects: ${stderr}`, () => {
      assert.strictEqual(isGitRegexError(stderr), true);
    });
  }

  test("does not flag unrelated git errors", () => {
    assert.strictEqual(isGitRegexError("fatal: not a git repository"), false);
    assert.strictEqual(isGitRegexError("fatal: ambiguous argument 'HEAD'"), false);
    assert.strictEqual(isGitRegexError(""), false);
  });
});

suite("buildHistoricalSearchArgs - git log argument construction", () => {
  const NOW = Date.UTC(2026, 5, 23, 12, 0, 0); // fixed instant for deterministic --since
  const base = {
    pattern: "foo",
    isRegex: false,
    caseInsensitive: false,
    includePattern: "",
    excludePattern: "",
    sinceDays: -1,
    includeMerges: false,
    nowMs: NOW,
  };

  test("plain unlimited search: -S, no --since / --diff-merges / -i", () => {
    const args = buildHistoricalSearchArgs(base);
    assert.ok(args.includes("log") && args.includes("-p"));
    assert.ok(args.includes("-S") && !args.includes("-G"));
    assert.strictEqual(args[args.length - 1], "foo");
    assert.ok(!args.some(a => a.startsWith("--since=")));
    assert.ok(!args.includes("--diff-merges=first-parent"));
    assert.ok(!args.includes("-i"));
  });

  test("config-neutralizing flags are always present", () => {
    const args = buildHistoricalSearchArgs(base);
    assert.ok(args.includes("diff.noprefix=false"));
    assert.ok(args.includes("diff.mnemonicPrefix=false"));
    assert.ok(args.includes("log.showSignature=false"));
    assert.ok(args.includes("--date=default"));
  });

  test("regex + case-insensitive: -G and -i", () => {
    const args = buildHistoricalSearchArgs({ ...base, isRegex: true, caseInsensitive: true });
    assert.ok(args.includes("-G") && !args.includes("-S"));
    assert.ok(args.includes("-i"));
  });

  test("includeMerges adds --diff-merges=first-parent", () => {
    const args = buildHistoricalSearchArgs({ ...base, includeMerges: true });
    assert.ok(args.includes("--diff-merges=first-parent"));
  });

  test("fractional sub-day window → exact ISO --since (not approxidate)", () => {
    const args = buildHistoricalSearchArgs({ ...base, sinceDays: 0.25 }); // 6h
    const expected = `--since=${new Date(NOW - 0.25 * 86400000).toISOString()}`;
    assert.ok(args.includes(expected), `expected ${expected} in ${JSON.stringify(args)}`);
  });

  test("include/exclude become pathspecs after a -- separator", () => {
    const args = buildHistoricalSearchArgs({ ...base, includePattern: "*.ts", excludePattern: "*.test.ts" });
    const sep = args.indexOf("--");
    assert.ok(sep !== -1, "expected -- separator");
    const specs = args.slice(sep + 1);
    assert.ok(specs.includes("*.ts"));
    assert.ok(specs.includes(":(exclude)*.test.ts"));
  });
});
