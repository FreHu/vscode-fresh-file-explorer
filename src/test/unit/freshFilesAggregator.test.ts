import * as assert from "assert";

import { aggregateAuthors, aggregateCommits } from "../../fresh-files/freshFilesAggregator";
import { FileMetadata, WorkspaceFolderInfo } from "../../types";
import { AbsolutePath, asAbsolutePath } from "../../pathTypes";

/** Build a FileMetadata with only the fields the aggregators read (branded fields passed as plain strings). */
function meta(fields: Record<string, unknown>): FileMetadata {
  return { date: new Date("2024-01-01"), ...fields } as FileMetadata;
}

function filesOf(entries: Array<[string, Record<string, unknown>]>): Map<AbsolutePath, FileMetadata> {
  const map = new Map<AbsolutePath, FileMetadata>();
  for (const [p, m] of entries) { map.set(asAbsolutePath(p), meta(m)); }
  return map;
}

suite("freshFilesAggregator", () => {
  suite("aggregateAuthors", () => {
    test("counts files per author, descending by count", () => {
      const files = filesOf([
        ["/r/a.ts", { author: "Alice" }],
        ["/r/b.ts", { author: "Bob" }],
        ["/r/c.ts", { author: "Alice" }],
        ["/r/d.ts", { author: "Alice" }],
      ]);
      const result = aggregateAuthors(files);
      assert.deepStrictEqual(
        result.map(a => [String(a.author), a.fileCount]),
        [["Alice", 3], ["Bob", 1]],
      );
    });

    test("blank author falls back to (unknown)", () => {
      const files = filesOf([["/r/a.ts", { author: "" }], ["/r/b.ts", {}]]);
      const result = aggregateAuthors(files);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(String(result[0].author), "(unknown)");
      assert.strictEqual(result[0].fileCount, 2);
    });

    test("empty map yields no authors", () => {
      assert.deepStrictEqual(aggregateAuthors(new Map()), []);
    });
  });

  suite("aggregateCommits", () => {
    const singleRepo: WorkspaceFolderInfo[] = [
      { path: asAbsolutePath("/work/proj"), name: "proj", gitRepos: [""] },
    ];

    test("dedups by hash and counts files per commit", () => {
      const files = filesOf([
        ["/work/proj/a.ts", { commitHash: "h1", commitMessage: "first", date: new Date("2024-03-01") }],
        ["/work/proj/b.ts", { commitHash: "h1", commitMessage: "first", date: new Date("2024-03-01") }],
        ["/work/proj/c.ts", { commitHash: "h2", commitMessage: "second", date: new Date("2024-02-01") }],
      ]);
      const result = aggregateCommits(files, singleRepo);
      assert.strictEqual(result.length, 2);
      const h1 = result.find(c => String(c.hash) === "h1")!;
      assert.strictEqual(h1.fileCount, 2);
      assert.strictEqual(h1.repoName, "proj");
    });

    test("skips pending files with no commit hash", () => {
      const files = filesOf([
        ["/work/proj/a.ts", { commitHash: "h1" }],
        ["/work/proj/pending.ts", {}],
      ]);
      const result = aggregateCommits(files, singleRepo);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(String(result[0].hash), "h1");
    });

    test("sorts newest commit first", () => {
      const files = filesOf([
        ["/work/proj/old.ts", { commitHash: "old", date: new Date("2024-01-01") }],
        ["/work/proj/new.ts", { commitHash: "new", date: new Date("2024-12-31") }],
      ]);
      const result = aggregateCommits(files, singleRepo);
      assert.deepStrictEqual(result.map(c => String(c.hash)), ["new", "old"]);
    });

    test("derives repo name from the matching sub-repo in a multi-repo folder", () => {
      const multiRepo: WorkspaceFolderInfo[] = [
        { path: asAbsolutePath("/work/mono"), name: "mono", gitRepos: ["packages/api", "packages/web"] },
      ];
      const files = filesOf([
        ["/work/mono/packages/api/x.ts", { commitHash: "a" }],
        ["/work/mono/packages/web/y.ts", { commitHash: "b" }],
      ]);
      const result = aggregateCommits(files, multiRepo);
      const api = result.find(c => String(c.hash) === "a")!;
      const web = result.find(c => String(c.hash) === "b")!;
      assert.strictEqual(api.repoName, "api");  // basename of "packages/api"
      assert.strictEqual(web.repoName, "web");  // basename of "packages/web"
    });
  });
});
