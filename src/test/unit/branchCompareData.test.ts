import * as assert from "assert";
import {
  parseDiffNameStatusZ,
  parseStatusPorcelainZ,
  buildChangedFiles,
  buildFolderTree,
  countFilesIn,
  ChangeStatus,
} from "../../branch-compare/branchCompareData";
import { asAbsolutePath } from "../../pathTypes";

suite("branchCompareData", () => {
  suite("parseDiffNameStatusZ", () => {
    test("empty input returns empty array", () => {
      assert.deepStrictEqual(parseDiffNameStatusZ(""), []);
    });

    test("parses simple modify", () => {
      const out = parseDiffNameStatusZ("M\0src/foo.ts\0");
      assert.deepStrictEqual(out, [{ status: "M", pathInRepo: "src/foo.ts" }]);
    });

    test("parses add and delete", () => {
      const out = parseDiffNameStatusZ("A\0src/added.ts\0D\0src/gone.ts\0");
      assert.deepStrictEqual(out, [
        { status: "A", pathInRepo: "src/added.ts" },
        { status: "D", pathInRepo: "src/gone.ts" },
      ]);
    });

    test("parses rename with similarity index → consumes two paths", () => {
      const out = parseDiffNameStatusZ("R100\0old/path.ts\0new/path.ts\0M\0other.ts\0");
      assert.deepStrictEqual(out, [
        { status: "R", pathInRepo: "new/path.ts", renameSource: "old/path.ts" },
        { status: "M", pathInRepo: "other.ts" },
      ]);
    });

    test("collapses copy (C) into rename status", () => {
      const out = parseDiffNameStatusZ("C75\0src.ts\0dst.ts\0");
      assert.deepStrictEqual(out, [
        { status: "R", pathInRepo: "dst.ts", renameSource: "src.ts" },
      ]);
    });

    test("handles no trailing NUL", () => {
      const out = parseDiffNameStatusZ("M\0a.ts");
      assert.deepStrictEqual(out, [{ status: "M", pathInRepo: "a.ts" }]);
    });

    test("parses T (type change) status letter", () => {
      const out = parseDiffNameStatusZ("T\0src/symlink.ts\0");
      assert.deepStrictEqual(out, [{ status: "T", pathInRepo: "src/symlink.ts" }]);
    });

    test("recovers from unknown status letter without desyncing", () => {
      // Unknown status `X` — parser should drop the letter + path and keep going.
      const out = parseDiffNameStatusZ("X\0bogus.ts\0M\0real.ts\0");
      assert.deepStrictEqual(out, [{ status: "M", pathInRepo: "real.ts" }]);
    });
  });

  suite("parseStatusPorcelainZ", () => {
    test("empty input returns empty array", () => {
      assert.deepStrictEqual(parseStatusPorcelainZ(""), []);
    });

    test("parses untracked file as U", () => {
      const out = parseStatusPorcelainZ("?? src/new.ts\0");
      assert.deepStrictEqual(out, [{ status: "U", pathInRepo: "src/new.ts" }]);
    });

    test("drops trailing-slash untracked entry (nested worktree/submodule boundary)", () => {
      // With -uall, ordinary untracked dirs are expanded to files; a surviving
      // `dir/` entry is a nested git boundary git refused to descend into and
      // must not render as a phantom changed file.
      const out = parseStatusPorcelainZ("?? feature-worktree/\0?? src/real.ts\0");
      assert.deepStrictEqual(out, [{ status: "U", pathInRepo: "src/real.ts" }]);
    });

    test("parses index modification → M", () => {
      const out = parseStatusPorcelainZ("M  src/foo.ts\0");
      assert.deepStrictEqual(out, [{ status: "M", pathInRepo: "src/foo.ts" }]);
    });

    test("parses worktree modification → M", () => {
      const out = parseStatusPorcelainZ(" M src/foo.ts\0");
      assert.deepStrictEqual(out, [{ status: "M", pathInRepo: "src/foo.ts" }]);
    });

    test("parses deletion → D regardless of column", () => {
      const out = parseStatusPorcelainZ("D  one.ts\0 D two.ts\0");
      assert.deepStrictEqual(out, [
        { status: "D", pathInRepo: "one.ts" },
        { status: "D", pathInRepo: "two.ts" },
      ]);
    });

    test("parses staged add as A", () => {
      const out = parseStatusPorcelainZ("A  added.ts\0");
      assert.deepStrictEqual(out, [{ status: "A", pathInRepo: "added.ts" }]);
    });

    test("parses rename → consumes a second NUL-separated source path", () => {
      // git status -z layout: `R  newpath\0oldpath\0`
      const out = parseStatusPorcelainZ("R  new/path.ts\0old/path.ts\0M  other.ts\0");
      assert.deepStrictEqual(out, [
        { status: "R", pathInRepo: "new/path.ts", renameSource: "old/path.ts" },
        { status: "M", pathInRepo: "other.ts" },
      ]);
    });

    test("filters out ignored entries (!!)", () => {
      const out = parseStatusPorcelainZ("!! ignored.ts\0M  real.ts\0");
      assert.deepStrictEqual(out, [{ status: "M", pathInRepo: "real.ts" }]);
    });

    test("parses type change in either column → T", () => {
      const out = parseStatusPorcelainZ("T  one.ts\0 T two.ts\0");
      assert.deepStrictEqual(out, [
        { status: "T", pathInRepo: "one.ts" },
        { status: "T", pathInRepo: "two.ts" },
      ]);
    });

    test("does not push phantom entries from empty fields", () => {
      // Empty intermediate field should be skipped, not push a "" entry.
      const out = parseStatusPorcelainZ("M  a.ts\0\0M  b.ts\0");
      assert.deepStrictEqual(out, [
        { status: "M", pathInRepo: "a.ts" },
        { status: "M", pathInRepo: "b.ts" },
      ]);
    });
  });

  suite("buildChangedFiles", () => {
    const repo = asAbsolutePath("/repos/myrepo");

    test("union with working-tree precedence over committed", () => {
      const committed = [
        { status: "M" as ChangeStatus, pathInRepo: "a.ts" },
        { status: "A" as ChangeStatus, pathInRepo: "b.ts" },
      ];
      const wt = [
        // a.ts has new working-tree changes — should override committed M
        { status: "M" as ChangeStatus, pathInRepo: "a.ts" },
        // c.ts is untracked, only present in working tree
        { status: "U" as ChangeStatus, pathInRepo: "c.ts" },
      ];
      const out = buildChangedFiles(repo, committed, wt);

      const byPath = new Map(out.map(f => [f.pathInRepo, f]));
      assert.strictEqual(byPath.size, 3);
      assert.strictEqual(byPath.get("a.ts")!.isPending, true, "WT entry should win");
      assert.strictEqual(byPath.get("b.ts")!.isPending, false, "committed-only stays committed");
      assert.strictEqual(byPath.get("c.ts")!.status, "U");
      assert.strictEqual(byPath.get("c.ts")!.isPending, true);
    });

    test("rename source is preserved", () => {
      const committed = [
        { status: "R" as ChangeStatus, pathInRepo: "new.ts", renameSource: "old.ts" },
      ];
      const out = buildChangedFiles(repo, committed, []);
      assert.strictEqual(out[0].renameSource, "old.ts");
    });

    test("working-tree numstat is attached to pending entries only", () => {
      const committed = [{ status: "M" as ChangeStatus, pathInRepo: "committed.ts" }];
      const wt = [
        { status: "M" as ChangeStatus, pathInRepo: "pending.ts" },
        { status: "U" as ChangeStatus, pathInRepo: "untracked.ts" }, // absent from numstat
      ];
      const numstat = new Map([["pending.ts", { added: 12, deleted: 4 }]]);
      const out = buildChangedFiles(repo, committed, wt, undefined, numstat);

      const byPath = new Map(out.map(f => [f.pathInRepo, f]));
      assert.strictEqual(byPath.get("pending.ts")!.linesAdded, 12);
      assert.strictEqual(byPath.get("pending.ts")!.linesDeleted, 4);
      // Untracked has no numstat entry → no counts.
      assert.strictEqual(byPath.get("untracked.ts")!.linesAdded, undefined);
      // Committed entries never get working-tree counts.
      assert.strictEqual(byPath.get("committed.ts")!.linesAdded, undefined);
    });

    test("output is sorted by path for deterministic rendering", () => {
      const committed = [
        { status: "M" as ChangeStatus, pathInRepo: "z.ts" },
        { status: "M" as ChangeStatus, pathInRepo: "a.ts" },
        { status: "M" as ChangeStatus, pathInRepo: "m.ts" },
      ];
      const out = buildChangedFiles(repo, committed, []);
      assert.deepStrictEqual(out.map(f => f.pathInRepo), ["a.ts", "m.ts", "z.ts"]);
    });
  });

  suite("buildFolderTree / countFilesIn", () => {
    const repo = asAbsolutePath("/repo");

    test("flat files all live at root", () => {
      const files = buildChangedFiles(repo,
        [{ status: "M" as ChangeStatus, pathInRepo: "a.ts" },
         { status: "M" as ChangeStatus, pathInRepo: "b.ts" }], []);
      const root = buildFolderTree(files);
      assert.strictEqual(root.children.size, 0);
      assert.strictEqual(root.files.length, 2);
      assert.strictEqual(countFilesIn(root), 2);
    });

    test("nested paths build folders with cumulative counts", () => {
      const files = buildChangedFiles(repo,
        [
          { status: "M" as ChangeStatus, pathInRepo: "src/a.ts" },
          { status: "M" as ChangeStatus, pathInRepo: "src/sub/b.ts" },
          { status: "M" as ChangeStatus, pathInRepo: "src/sub/c.ts" },
          { status: "M" as ChangeStatus, pathInRepo: "doc/readme.md" },
        ], []);
      const root = buildFolderTree(files);

      assert.strictEqual(root.children.size, 2);
      const src = root.children.get("src")!;
      assert.strictEqual(src.files.length, 1, "a.ts lives in src/");
      assert.strictEqual(src.children.size, 1);

      const sub = src.children.get("sub")!;
      assert.strictEqual(sub.files.length, 2);
      assert.strictEqual(countFilesIn(src), 3);
      assert.strictEqual(countFilesIn(root), 4);
    });
  });
});
