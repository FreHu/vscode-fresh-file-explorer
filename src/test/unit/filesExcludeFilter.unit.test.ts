import * as assert from "assert";
import { FilesExcludeFilter, findOwningFolder } from "../../fresh-files/filesExcludeFilter";

function mapOf(...paths: string[]): Map<string, number> {
  return new Map(paths.map((p, i) => [p, i]));
}

suite("FilesExcludeFilter", () => {
  suite("findOwningFolder", () => {
    const folders = [{ path: "/repo" }, { path: "/repo/backend" }];

    test("picks the most specific (longest-prefix) folder for overlapping roots", () => {
      assert.strictEqual(findOwningFolder("/repo/backend/src/a.ts", folders)?.path, "/repo/backend");
      assert.strictEqual(findOwningFolder("/repo/README.md", folders)?.path, "/repo");
    });

    test("returns undefined when no folder owns the path", () => {
      assert.strictEqual(findOwningFolder("/elsewhere/x", folders), undefined);
    });
  });

  suite("isExcludedUnder — per node (the issue #3 case)", () => {
    // Root excludes backend/web; backend (its own root) excludes nothing.
    const expressions: Record<string, Record<string, unknown>> = {
      "/repo": { backend: true, web: true },
      "/repo/backend": {},
    };
    const filter = new FilesExcludeFilter(() => true, (p) => expressions[p] ?? {});
    const root = { path: "/repo" };
    const backend = { path: "/repo/backend" };

    test("backend file is hidden UNDER the root node (relative path matches root's glob)", () => {
      assert.strictEqual(filter.isExcludedUnder("/repo/backend/src/app.js", root), true);
    });

    test("the same file is SHOWN under the backend node (backend excludes nothing)", () => {
      assert.strictEqual(filter.isExcludedUnder("/repo/backend/src/app.js", backend), false);
    });

    test("unrelated root files stay visible under the root node", () => {
      assert.strictEqual(filter.isExcludedUnder("/repo/README.md", root), false);
    });

    test("a path not under the given folder is never excluded by it", () => {
      assert.strictEqual(filter.isExcludedUnder("/elsewhere/x", root), false);
    });

    test("returns false when the feature is disabled", () => {
      const off = new FilesExcludeFilter(() => false, () => ({ backend: true }));
      assert.strictEqual(off.isExcludedUnder("/repo/backend/x", root), false);
    });
  });

  suite("isExcludedByOwner / filterByOwner — flat lenses", () => {
    const folders = [{ path: "/repo" }, { path: "/repo/backend" }];

    test("a file is judged by its OWN folder's excludes, not an ancestor root's", () => {
      // Root excludes backend, but backend is its own root that excludes nothing,
      // so in a flat lens the backend file is owned-by backend → not excluded.
      const expressions: Record<string, Record<string, unknown>> = {
        "/repo": { backend: true },
        "/repo/backend": {},
      };
      const filter = new FilesExcludeFilter(() => true, (p) => expressions[p] ?? {});
      assert.strictEqual(filter.isExcludedByOwner("/repo/backend/app.js", folders), false);
      assert.strictEqual(filter.isExcludedByOwner("/repo/build/x.js", folders), false);
    });

    test("filterByOwner drops files excluded by their owning folder", () => {
      const filter = new FilesExcludeFilter(() => true, () => ({ dist: true }));
      const result = filter.filterByOwner(
        mapOf("/repo/README.md", "/repo/dist/bundle.js", "/repo/backend/dist/x.js"),
        folders,
      );
      // /repo/dist/* excluded by root; /repo/backend/dist/* excluded by backend.
      assert.deepStrictEqual([...result.keys()], ["/repo/README.md"]);
    });

    test("returns the SAME reference when disabled", () => {
      const filter = new FilesExcludeFilter(() => false, () => ({ dist: true }));
      const map = mapOf("/repo/dist/a.js");
      assert.strictEqual(filter.filterByOwner(map, folders), map);
    });

    test("returns the SAME reference when nothing is excluded", () => {
      const filter = new FilesExcludeFilter(() => true, () => ({}));
      const map = mapOf("/repo/a.ts", "/repo/backend/b.ts");
      assert.strictEqual(filter.filterByOwner(map, folders), map);
    });
  });

  suite("invalidate", () => {
    test("forces a config re-read", () => {
      let exclude = false;
      const folders = [{ path: "/repo" }];
      const filter = new FilesExcludeFilter(() => true, () => (exclude ? { dist: true } : {}));

      assert.strictEqual(filter.isExcludedUnder("/repo/dist/a.js", folders[0]), false);
      exclude = true;
      assert.strictEqual(filter.isExcludedUnder("/repo/dist/a.js", folders[0]), false); // cached
      filter.invalidate();
      assert.strictEqual(filter.isExcludedUnder("/repo/dist/a.js", folders[0]), true); // re-read
    });
  });
});
