import * as assert from "assert";
import { HeatmapFileState } from "../../heatmap/heatmapFileState";

// The invariant under test: a cached decoration set must never outlive the
// mode that owns it. The controller repaints from the cache without checking
// the mode, so an orphan repaints a file the heatmap already gave up on.

function state() {
  return new HeatmapFileState<string, { buckets: number }>();
}

const FILE = "/repo/src/a.ts";

suite("HeatmapFileState", () => {
  test("mode and cache round-trip", () => {
    const s = state();
    s.setMode(FILE, "age");
    s.setCache(FILE, { buckets: 3 });
    assert.strictEqual(s.getMode(FILE), "age");
    assert.strictEqual(s.hasMode(FILE), true);
    assert.deepStrictEqual(s.getCache(FILE), { buckets: 3 });
  });

  test("trackedPaths is a snapshot: forgetting while iterating drops every file", () => {
    const s = state();
    s.setMode(FILE, "age");
    s.setMode("/repo/b.ts", "branch");
    for (const p of s.trackedPaths()) { s.forget(p); }
    assert.deepStrictEqual(s.trackedPaths(), []);
  });

  test("unknown file yields undefined, not a throw", () => {
    const s = state();
    assert.strictEqual(s.getMode("/nope"), undefined);
    assert.strictEqual(s.getCache("/nope"), undefined);
    assert.strictEqual(s.hasMode("/nope"), false);
  });

  test("forget() drops both maps", () => {
    const s = state();
    s.setMode(FILE, "age");
    s.setCache(FILE, { buckets: 3 });
    s.forget(FILE);
    assert.strictEqual(s.getMode(FILE), undefined);
    assert.strictEqual(s.getCache(FILE), undefined);
    assert.strictEqual(s.hasOrphanedCache(), false);
  });

  // The bug this type exists to prevent: eight bail-out paths dropped the mode
  // and left the cache, so reopening the tab repainted stale decorations.
  test("forget() leaves no orphaned cache even when only the mode was set", () => {
    const s = state();
    s.setMode(FILE, "age");
    s.forget(FILE);
    assert.strictEqual(s.hasOrphanedCache(), false);
  });

  test("invalidateCache() keeps the mode so the next apply recomputes", () => {
    const s = state();
    s.setMode(FILE, "branch");
    s.setCache(FILE, { buckets: 3 });
    s.invalidateCache(FILE);
    assert.strictEqual(s.getCache(FILE), undefined, "cache should be gone");
    assert.strictEqual(s.getMode(FILE), "branch", "mode must survive a recompute");
    assert.strictEqual(s.hasOrphanedCache(), false);
  });

  test("hasOrphanedCache() detects a cache with no owning mode", () => {
    const s = state();
    s.setCache(FILE, { buckets: 1 });
    assert.strictEqual(s.hasOrphanedCache(), true, "cache without a mode is an orphan");
    s.setMode(FILE, "age");
    assert.strictEqual(s.hasOrphanedCache(), false);
  });

  test("files are tracked independently", () => {
    const s = state();
    const other = "/repo/src/b.ts";
    s.setMode(FILE, "age");
    s.setCache(FILE, { buckets: 1 });
    s.setMode(other, "branch");
    s.setCache(other, { buckets: 2 });

    s.forget(FILE);

    assert.strictEqual(s.getMode(other), "branch");
    assert.deepStrictEqual(s.getCache(other), { buckets: 2 });
    assert.strictEqual(s.hasOrphanedCache(), false);
  });

  test("cachedValues() yields every cached entry for bulk disposal", () => {
    const s = state();
    s.setMode(FILE, "age");
    s.setCache(FILE, { buckets: 1 });
    s.setMode("/repo/src/b.ts", "age");
    s.setCache("/repo/src/b.ts", { buckets: 2 });
    const seen = [...s.cachedValues()].map(c => c.buckets).sort();
    assert.deepStrictEqual(seen, [1, 2]);
  });
});
