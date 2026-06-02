import * as assert from "assert";
import * as vscode from "vscode";

import { SavedComparisonsService, HEAD_SOURCE } from "../../branch-compare/savedComparisonsService";
import { WorkspaceStateManager } from "../../extension/workspaceStateManager";
import { asNormalizedRepoPath } from "../../pathTypes";

/**
 * Fabricate a minimal `vscode.ExtensionContext` whose `workspaceState` is
 * backed by an in-memory map. Lets us exercise `SavedComparisonsService` and
 * its migration path without an actual extension host.
 */
function makeFakeContext(seed?: Record<string, unknown>): vscode.ExtensionContext {
  const store = new Map<string, unknown>(Object.entries(seed ?? {}));
  return {
    workspaceState: {
      get(key: string, fallback?: unknown) {
        return store.has(key) ? store.get(key) : fallback;
      },
      update(key: string, value: unknown): Thenable<void> {
        if (value === undefined) {
          store.delete(key);
        } else {
          store.set(key, value);
        }
        return Promise.resolve();
      },
      keys(): readonly string[] {
        return [...store.keys()];
      },
      setKeysForSync() { /* no-op */ },
    },
  } as unknown as vscode.ExtensionContext;
}

const REPO_A = "/repos/alpha";
const REPO_B = "/repos/bravo";

suite("SavedComparisonsService", () => {
  let service: SavedComparisonsService;

  setup(() => {
    WorkspaceStateManager.initialize(makeFakeContext());
    service = new SavedComparisonsService();
  });

  teardown(() => {
    service.dispose();
  });

  suite("add", () => {
    test("creates a new comparison and defaults to active=true", () => {
      const id = service.add({ repoFullPath: REPO_A, source: HEAD_SOURCE, target: "main" });
      const all = service.getAll();
      assert.strictEqual(all.length, 1);
      assert.strictEqual(all[0].id, id);
      assert.strictEqual(all[0].active, true);
      assert.strictEqual(all[0].source, HEAD_SOURCE);
      assert.strictEqual(all[0].target, "main");
    });

    test("setting isHeatmapBaseline=true clears the flag from siblings in the same repo", () => {
      service.add({
        repoFullPath: REPO_A, source: HEAD_SOURCE, target: "main", isHeatmapBaseline: true,
      });
      const second = service.add({
        repoFullPath: REPO_A, source: HEAD_SOURCE, target: "v1.0", isHeatmapBaseline: true,
      });
      const all = service.getAll();
      assert.strictEqual(all.length, 2);
      const heatmapHolders = all.filter(c => c.isHeatmapBaseline);
      assert.strictEqual(heatmapHolders.length, 1);
      assert.strictEqual(heatmapHolders[0].id, second);
    });

    test("isHeatmapBaseline=true on one repo doesn't touch siblings in another repo", () => {
      service.add({
        repoFullPath: REPO_A, source: HEAD_SOURCE, target: "main", isHeatmapBaseline: true,
      });
      service.add({
        repoFullPath: REPO_B, source: HEAD_SOURCE, target: "main", isHeatmapBaseline: true,
      });
      const heatmapHolders = service.getAll().filter(c => c.isHeatmapBaseline);
      assert.strictEqual(heatmapHolders.length, 2);
    });
  });

  suite("update", () => {
    test("patches a single field and fires onDidChange", () => {
      const id = service.add({ repoFullPath: REPO_A, source: HEAD_SOURCE, target: "main" });
      const events: string[][] = [];
      service.onDidChange(e => { events.push(e.ids ?? []); });

      service.update(id, { label: "renamed" });
      assert.strictEqual(service.getById(id)?.label, "renamed");
      assert.deepStrictEqual(events, [[id]]);
    });

    test("no-op patch does not fire onDidChange or persist", () => {
      const id = service.add({ repoFullPath: REPO_A, source: HEAD_SOURCE, target: "main", label: "x" });
      let fired = 0;
      service.onDidChange(() => { fired++; });

      service.update(id, { source: HEAD_SOURCE, target: "main", label: "x", active: true });
      assert.strictEqual(fired, 0, "no fields actually changed");
    });

    test("setting isHeatmapBaseline=true on a non-HEAD source is silently rejected", () => {
      const id = service.add({ repoFullPath: REPO_A, source: "feature-x", target: "main" });
      service.update(id, { isHeatmapBaseline: true });
      // Both undefined and false are valid "not the heatmap baseline" — the
      // service may set the flag to false explicitly or just never set it.
      assert.notStrictEqual(service.getById(id)?.isHeatmapBaseline, true);
    });
  });

  suite("delete", () => {
    test("removes by id and fires onDidChange", () => {
      const id = service.add({ repoFullPath: REPO_A, source: HEAD_SOURCE, target: "main" });
      const events: string[][] = [];
      service.onDidChange(e => { events.push(e.ids ?? []); });

      service.delete(id);
      assert.strictEqual(service.getAll().length, 0);
      assert.deepStrictEqual(events, [[id]]);
    });

    test("deleting an unknown id is a no-op", () => {
      let fired = 0;
      service.onDidChange(() => { fired++; });
      service.delete("nonexistent");
      assert.strictEqual(fired, 0);
    });
  });

  suite("move", () => {
    function ids(): string[] {
      return service.getAll().map(c => c.id);
    }

    test("moving down swaps with the next entry", () => {
      const a = service.add({ repoFullPath: REPO_A, source: HEAD_SOURCE, target: "main" });
      const b = service.add({ repoFullPath: REPO_A, source: HEAD_SOURCE, target: "v1" });
      const c = service.add({ repoFullPath: REPO_A, source: HEAD_SOURCE, target: "v2" });
      service.move(a, 1);
      assert.deepStrictEqual(ids(), [b, a, c]);
    });

    test("moving up swaps with the previous entry", () => {
      const a = service.add({ repoFullPath: REPO_A, source: HEAD_SOURCE, target: "main" });
      const b = service.add({ repoFullPath: REPO_A, source: HEAD_SOURCE, target: "v1" });
      const c = service.add({ repoFullPath: REPO_A, source: HEAD_SOURCE, target: "v2" });
      service.move(c, -1);
      assert.deepStrictEqual(ids(), [a, c, b]);
    });

    test("moving past either bound clamps and does not fire onDidChange", () => {
      const a = service.add({ repoFullPath: REPO_A, source: HEAD_SOURCE, target: "main" });
      service.add({ repoFullPath: REPO_A, source: HEAD_SOURCE, target: "v1" });
      let fired = 0;
      service.onDidChange(() => { fired++; });

      service.move(a, -1); // already at top
      assert.strictEqual(fired, 0);

      service.move(a, 99); // jumps to the bottom — counts as a move
      assert.strictEqual(fired, 1);
    });

    test("moving an unknown id is a no-op", () => {
      service.add({ repoFullPath: REPO_A, source: HEAD_SOURCE, target: "main" });
      let fired = 0;
      service.onDidChange(() => { fired++; });
      service.move("nonexistent", 1);
      assert.strictEqual(fired, 0);
    });

    test("move fires onDidChange with reorderOnly=true so receivers can skip refetching", () => {
      const a = service.add({ repoFullPath: REPO_A, source: HEAD_SOURCE, target: "main" });
      service.add({ repoFullPath: REPO_A, source: HEAD_SOURCE, target: "v1" });
      let captured: { reorderOnly?: boolean } | undefined;
      service.onDidChange(e => { captured = e; });
      service.move(a, 1);
      assert.strictEqual(captured?.reorderOnly, true);
    });

    test("moveTo lands the item at an absolute index (splice semantics)", () => {
      const a = service.add({ repoFullPath: REPO_A, source: HEAD_SOURCE, target: "main" });
      const b = service.add({ repoFullPath: REPO_A, source: HEAD_SOURCE, target: "v1" });
      const c = service.add({ repoFullPath: REPO_A, source: HEAD_SOURCE, target: "v2" });
      const d = service.add({ repoFullPath: REPO_A, source: HEAD_SOURCE, target: "v3" });

      // Move first to position 2 → [B, C, A, D]
      service.moveTo(a, 2);
      assert.deepStrictEqual(ids(), [b, c, a, d]);

      // Move last to position 0 → [D, B, C, A]
      service.moveTo(d, 0);
      assert.deepStrictEqual(ids(), [d, b, c, a]);
    });

    test("moveTo to current index is a no-op", () => {
      const a = service.add({ repoFullPath: REPO_A, source: HEAD_SOURCE, target: "main" });
      service.add({ repoFullPath: REPO_A, source: HEAD_SOURCE, target: "v1" });
      let fired = 0;
      service.onDidChange(() => { fired++; });
      service.moveTo(a, 0);
      assert.strictEqual(fired, 0);
    });
  });

  suite("heatmap baseline", () => {
    test("setHeatmapBaseline(undefined) clears every flag across all repos", () => {
      const a = service.add({
        repoFullPath: REPO_A, source: HEAD_SOURCE, target: "main", isHeatmapBaseline: true,
      });
      const b = service.add({
        repoFullPath: REPO_B, source: HEAD_SOURCE, target: "main", isHeatmapBaseline: true,
      });
      service.setHeatmapBaseline(undefined);
      assert.notStrictEqual(service.getById(a)?.isHeatmapBaseline, true);
      assert.notStrictEqual(service.getById(b)?.isHeatmapBaseline, true);
    });

    test("setHeatmapBaseline rejects non-HEAD sources silently", () => {
      const id = service.add({ repoFullPath: REPO_A, source: "feature-x", target: "main" });
      service.setHeatmapBaseline(id);
      assert.notStrictEqual(service.getById(id)?.isHeatmapBaseline, true);
    });

    test("setHeatmapBaselineByRefForRepo reuses an existing match without flipping active", () => {
      const id = service.add({
        repoFullPath: REPO_A, source: HEAD_SOURCE, target: "main", active: false,
      });
      const returned = service.setHeatmapBaselineByRefForRepo(REPO_A, "main");
      assert.strictEqual(returned, id, "should reuse the existing comparison");
      const cmp = service.getById(id)!;
      assert.strictEqual(cmp.isHeatmapBaseline, true);
      assert.strictEqual(cmp.active, false, "must not silently un-hide the row");
    });

    test("setHeatmapBaselineByRefForRepo creates a new HEAD-source comparison when none matches", () => {
      const id = service.setHeatmapBaselineByRefForRepo(REPO_A, "main");
      const cmp = service.getById(id)!;
      assert.strictEqual(cmp.source, HEAD_SOURCE);
      assert.strictEqual(cmp.target, "main");
      assert.strictEqual(cmp.isHeatmapBaseline, true);
      assert.strictEqual(cmp.active, true);
    });

    test("clearHeatmapBaselineForRepoByRef leaves the comparison intact but drops the flag", () => {
      const id = service.add({
        repoFullPath: REPO_A, source: HEAD_SOURCE, target: "main", isHeatmapBaseline: true,
      });
      service.clearHeatmapBaselineForRepoByRef(REPO_A);
      const cmp = service.getById(id)!;
      assert.notStrictEqual(cmp.isHeatmapBaseline, true);
      assert.strictEqual(cmp.active, true, "comparison stays alive — just no longer the heatmap baseline");
    });
  });

  suite("load", () => {
    test("rehydrates persisted comparisons, re-branding the repo path", () => {
      service.dispose();
      const repoKey = asNormalizedRepoPath(REPO_A);
      WorkspaceStateManager.initialize(makeFakeContext({
        branchCompareSavedComparisons: [{
          id: "cmp-existing",
          repoFullPath: repoKey,
          source: HEAD_SOURCE,
          target: "main",
          active: true,
        }],
      }));
      service = new SavedComparisonsService();

      const all = service.getAll();
      assert.strictEqual(all.length, 1);
      assert.strictEqual(all[0].id, "cmp-existing");
      assert.strictEqual(all[0].repoFullPath, repoKey);
      assert.strictEqual(all[0].target, "main");
    });

    test("empty workspace state yields no comparisons", () => {
      service.dispose();
      WorkspaceStateManager.initialize(makeFakeContext());
      service = new SavedComparisonsService();
      assert.strictEqual(service.getAll().length, 0);
    });
  });

  suite("grouping mode", () => {
    test("add defaults groupingMode to File Structure", () => {
      const id = service.add({ repoFullPath: REPO_A, source: HEAD_SOURCE, target: "main" });
      assert.strictEqual(service.getById(id)?.groupingMode, "File Structure");
    });

    test("a record persisted before the field existed loads as File Structure", () => {
      service.dispose();
      WorkspaceStateManager.initialize(makeFakeContext({
        branchCompareSavedComparisons: [{
          id: "cmp-legacy",
          repoFullPath: asNormalizedRepoPath(REPO_A),
          source: HEAD_SOURCE,
          target: "main",
          active: true,
          // no groupingMode
        }],
      }));
      service = new SavedComparisonsService();
      assert.strictEqual(service.getById("cmp-legacy")?.groupingMode, "File Structure");
    });

    test("a grouping-only update fires displayOnly=true (no diff re-fetch signal)", () => {
      const id = service.add({ repoFullPath: REPO_A, source: HEAD_SOURCE, target: "main" });
      let captured: { ids?: string[]; displayOnly?: boolean } | undefined;
      service.onDidChange(e => { captured = e; });

      service.update(id, { groupingMode: "Author" });
      assert.strictEqual(service.getById(id)?.groupingMode, "Author");
      assert.deepStrictEqual(captured?.ids, [id]);
      assert.strictEqual(captured?.displayOnly, true);
    });

    test("an update touching a data field is NOT displayOnly even if grouping also changed", () => {
      const id = service.add({ repoFullPath: REPO_A, source: HEAD_SOURCE, target: "main" });
      let captured: { displayOnly?: boolean } | undefined;
      service.onDidChange(e => { captured = e; });

      service.update(id, { groupingMode: "Author", target: "v1" });
      assert.notStrictEqual(captured?.displayOnly, true, "data change must take the full re-fetch path");
    });

    test("re-setting the same groupingMode is a no-op", () => {
      const id = service.add({ repoFullPath: REPO_A, source: HEAD_SOURCE, target: "main" });
      let fired = 0;
      service.onDidChange(() => { fired++; });
      service.update(id, { groupingMode: "File Structure" }); // already the default
      assert.strictEqual(fired, 0);
    });

    test("setAllGroupingModes sets every comparison and fires one displayOnly event", () => {
      const a = service.add({ repoFullPath: REPO_A, source: HEAD_SOURCE, target: "main" });
      const b = service.add({ repoFullPath: REPO_B, source: HEAD_SOURCE, target: "main" });
      let fireCount = 0;
      let captured: { ids?: string[]; displayOnly?: boolean } | undefined;
      service.onDidChange(e => { fireCount++; captured = e; });

      service.setAllGroupingModes("Moon Phase");
      assert.strictEqual(fireCount, 1);
      assert.strictEqual(captured?.displayOnly, true);
      assert.deepStrictEqual([...(captured?.ids ?? [])].sort(), [a, b].sort());
      assert.strictEqual(service.getById(a)?.groupingMode, "Moon Phase");
      assert.strictEqual(service.getById(b)?.groupingMode, "Moon Phase");
    });

    test("setAllGroupingModes with no comparisons is a no-op", () => {
      let fired = 0;
      service.onDidChange(() => { fired++; });
      service.setAllGroupingModes("Flat List");
      assert.strictEqual(fired, 0);
    });

    test("groupingMode round-trips through persistence", () => {
      const id = service.add({ repoFullPath: REPO_A, source: HEAD_SOURCE, target: "main" });
      service.update(id, { groupingMode: "Retrograde" });
      // Re-load from the same backing store.
      service.dispose();
      service = new SavedComparisonsService();
      assert.strictEqual(service.getById(id)?.groupingMode, "Retrograde");
    });
  });
});
