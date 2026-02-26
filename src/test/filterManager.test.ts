import * as assert from "assert";
import { FilterManager } from "../fresh-files/freshFileFilterManager";
import { FileMetadata, asCommitHash } from "../types";

suite("FilterManager", () => {
  let filterManager: FilterManager;

  setup(() => {
    filterManager = new FilterManager();
    filterManager.initialize();
  });

  suite("hasActiveFilters", () => {
    test("should return false when no filters are active", () => {
      assert.strictEqual(filterManager.hasActiveFilters(), false);
    });

    test("should return true when author filters are active", () => {
      filterManager.setExcludedAuthors(new Set(["Alice"]));
      assert.strictEqual(filterManager.hasActiveFilters(), true);
    });

    test("should return true when commit filters are active", () => {
      filterManager.setExcludedCommits(new Set([asCommitHash("abc123")]));
      assert.strictEqual(filterManager.hasActiveFilters(), true);
    });

    test("should return true when both filters are active", () => {
      filterManager.setExcludedAuthors(new Set(["Alice"]));
      filterManager.setExcludedCommits(new Set([asCommitHash("abc123")]));
      assert.strictEqual(filterManager.hasActiveFilters(), true);
    });

    test("should return false after clearing filters", () => {
      filterManager.setExcludedAuthors(new Set(["Alice"]));
      filterManager.clearFilters();
      assert.strictEqual(filterManager.hasActiveFilters(), false);
    });
  });

  suite("getFilterSummary", () => {
    test("should return empty string when no filters are active", () => {
      assert.strictEqual(filterManager.getFilterSummary(), "");
    });

    test("should return author count when only author filters are active", () => {
      filterManager.setExcludedAuthors(new Set(["Alice", "Bob"]));
      assert.strictEqual(filterManager.getFilterSummary(), "2 author(s) hidden");
    });

    test("should return commit count when only commit filters are active", () => {
      filterManager.setExcludedCommits(new Set([asCommitHash("abc123"), asCommitHash("def456")]));
      assert.strictEqual(filterManager.getFilterSummary(), "2 commit(s) hidden");
    });

    test("should return both counts when both filters are active", () => {
      filterManager.setExcludedAuthors(new Set(["Alice"]));
      filterManager.setExcludedCommits(new Set([asCommitHash("abc123")]));
      assert.strictEqual(filterManager.getFilterSummary(), "1 author(s) hidden, 1 commit(s) hidden");
    });
  });

  suite("passesFilters", () => {
    test("should return true when no filters are active", () => {
      const metadata: FileMetadata = {
        date: new Date(),
        author: "Alice" as any,
        commitHash: asCommitHash("abc123"),
      };
      assert.strictEqual(filterManager.passesFilters(metadata), true);
    });

    test("should return false when author is excluded", () => {
      filterManager.setExcludedAuthors(new Set(["Alice"]));
      const metadata: FileMetadata = {
        date: new Date(),
        author: "Alice" as any,
        commitHash: asCommitHash("abc123"),
      };
      assert.strictEqual(filterManager.passesFilters(metadata), false);
    });

    test("should return true when different author is excluded", () => {
      filterManager.setExcludedAuthors(new Set(["Bob"]));
      const metadata: FileMetadata = {
        date: new Date(),
        author: "Alice" as any,
        commitHash: asCommitHash("abc123"),
      };
      assert.strictEqual(filterManager.passesFilters(metadata), true);
    });

    test("should return false when commit is excluded", () => {
      filterManager.setExcludedCommits(new Set([asCommitHash("abc123")]));
      const metadata: FileMetadata = {
        date: new Date(),
        author: "Alice" as any,
        commitHash: asCommitHash("abc123"),
      };
      assert.strictEqual(filterManager.passesFilters(metadata), false);
    });

    test("should return true when different commit is excluded", () => {
      filterManager.setExcludedCommits(new Set([asCommitHash("def456")]));
      const metadata: FileMetadata = {
        date: new Date(),
        author: "Alice" as any,
        commitHash: asCommitHash("abc123"),
      };
      assert.strictEqual(filterManager.passesFilters(metadata), true);
    });

    test("should handle metadata without author (pending changes)", () => {
      filterManager.setExcludedAuthors(new Set(["Alice"]));
      const metadata: FileMetadata = {
        date: new Date(),
        isPending: true,
      };
      assert.strictEqual(filterManager.passesFilters(metadata), true);
    });

    test("should exclude metadata with (unknown) author when that is excluded", () => {
      filterManager.setExcludedAuthors(new Set(["(unknown)"]));
      const metadata: FileMetadata = {
        date: new Date(),
      };
      assert.strictEqual(filterManager.passesFilters(metadata), false);
    });

    test("should handle metadata without commitHash", () => {
      filterManager.setExcludedCommits(new Set([asCommitHash("abc123")]));
      const metadata: FileMetadata = {
        date: new Date(),
        author: "Alice" as any,
      };
      assert.strictEqual(filterManager.passesFilters(metadata), true);
    });

    test("should return false when both author and commit match exclusions", () => {
      filterManager.setExcludedAuthors(new Set(["Alice"]));
      filterManager.setExcludedCommits(new Set([asCommitHash("abc123")]));
      const metadata: FileMetadata = {
        date: new Date(),
        author: "Alice" as any,
        commitHash: asCommitHash("abc123"),
      };
      assert.strictEqual(filterManager.passesFilters(metadata), false);
    });

    test("should return false when only author matches exclusion (with both filters active)", () => {
      filterManager.setExcludedAuthors(new Set(["Alice"]));
      filterManager.setExcludedCommits(new Set([asCommitHash("def456")]));
      const metadata: FileMetadata = {
        date: new Date(),
        author: "Alice" as any,
        commitHash: asCommitHash("abc123"),
      };
      assert.strictEqual(filterManager.passesFilters(metadata), false);
    });

    test("should return false when only commit matches exclusion (with both filters active)", () => {
      filterManager.setExcludedAuthors(new Set(["Bob"]));
      filterManager.setExcludedCommits(new Set([asCommitHash("abc123")]));
      const metadata: FileMetadata = {
        date: new Date(),
        author: "Alice" as any,
        commitHash: asCommitHash("abc123"),
      };
      assert.strictEqual(filterManager.passesFilters(metadata), false);
    });
  });

  suite("getExcludedAuthors and getExcludedCommits", () => {
    test("should return excluded authors", () => {
      const authors = new Set(["Alice", "Bob"]);
      filterManager.setExcludedAuthors(authors);
      assert.deepStrictEqual(filterManager.getExcludedAuthors(), authors);
    });

    test("should return excluded commits", () => {
      const commits = new Set([asCommitHash("abc123"), asCommitHash("def456")]);
      filterManager.setExcludedCommits(commits);
      assert.deepStrictEqual(filterManager.getExcludedCommits(), commits);
    });
  });
});
