import * as assert from "assert";
// Type-only import so this pure unit test never pulls in pathTypes.ts's
// runtime module — asAbsolutePath() there calls normalizePath() from
// utils.ts, which imports vscode and isn't available outside the extension host.
import type { AbsolutePath } from "../../pathTypes";
import type { WorkspaceFolderInfo } from "../../types";
import {
  fileInTargetRepo,
  fileMapExcludingRepos,
  buildTargetWorkspaceFolders,
  computeHistoricalLoadPlan,
  scopeFilesByRepo,
} from "../../fresh-files/freshFileMapUtils";

const abs = (p: string): AbsolutePath => p as AbsolutePath;

suite("fileInTargetRepo", () => {
  test("matches an exact repo path", () => {
    assert.strictEqual(fileInTargetRepo("/work/proj", ["/work/proj"]), true);
  });

  test("matches a file nested under a target repo", () => {
    assert.strictEqual(fileInTargetRepo("/work/proj/src/a.ts", ["/work/proj"]), true);
  });

  test("does not match a sibling repo whose name is a prefix", () => {
    assert.strictEqual(fileInTargetRepo("/work/proj2/a.ts", ["/work/proj"]), false);
  });

  test("no match when no target repo contains the path", () => {
    assert.strictEqual(fileInTargetRepo("/work/other/a.ts", ["/work/proj"]), false);
  });
});

suite("fileMapExcludingRepos", () => {
  test("drops entries under the target repos, keeps the rest", () => {
    const map = new Map<AbsolutePath, number>([
      [abs("/work/proj/a.ts"), 1],
      [abs("/work/other/b.ts"), 2],
    ]);
    const result = fileMapExcludingRepos(map, ["/work/proj"]);
    assert.deepStrictEqual([...result.keys()], [abs("/work/other/b.ts")]);
  });

  test("empty targetRepoPaths keeps everything", () => {
    const map = new Map<AbsolutePath, number>([[abs("/work/proj/a.ts"), 1]]);
    const result = fileMapExcludingRepos(map, []);
    assert.strictEqual(result.size, 1);
  });
});

suite("buildTargetWorkspaceFolders", () => {
  test("keeps only the repos present in targetRepoPaths", () => {
    const folders: WorkspaceFolderInfo[] = [
      { path: abs("/work/mono"), name: "mono", gitRepos: ["packages/api", "packages/web"] },
    ];
    const result = buildTargetWorkspaceFolders(folders, ["/work/mono/packages/api"]);
    assert.deepStrictEqual(result, [
      { path: abs("/work/mono"), name: "mono", gitRepos: ["packages/api"] },
    ]);
  });

  test("drops a folder entirely when none of its repos are targeted", () => {
    const folders: WorkspaceFolderInfo[] = [
      { path: abs("/work/proj"), name: "proj", gitRepos: [""] },
    ];
    const result = buildTargetWorkspaceFolders(folders, ["/work/other"]);
    assert.deepStrictEqual(result, []);
  });

  test("root repo (empty gitRepos entry) resolves to the folder path itself", () => {
    const folders: WorkspaceFolderInfo[] = [
      { path: abs("/work/proj"), name: "proj", gitRepos: [""] },
    ];
    const result = buildTargetWorkspaceFolders(folders, ["/work/proj"]);
    assert.strictEqual(result.length, 1);
  });
});

suite("computeHistoricalLoadPlan", () => {
  test("pending-only mode needs no thresholds", () => {
    const plan = computeHistoricalLoadPlan([{ days: 7 }, { days: 30 }], 0, true, true);
    assert.deepStrictEqual(plan.thresholds, []);
  });

  test("incremental loading off collapses thresholds to just the selected window", () => {
    const plan = computeHistoricalLoadPlan([{ days: 7 }, { days: 30 }], 30, false, false);
    assert.deepStrictEqual(plan.thresholds, [30]);
  });

  test("incremental loading on thresholds at or below the selected window", () => {
    const plan = computeHistoricalLoadPlan([{ days: 7 }, { days: 14 }, { days: 30 }], 14, false, true);
    assert.deepStrictEqual(plan.thresholds, [7, 14]);
  });

  test("maxDays is the widest configured window", () => {
    const plan = computeHistoricalLoadPlan([{ days: 7 }, { days: 30 }], 7, false, true);
    assert.strictEqual(plan.maxDays, 30);
  });

  test("no configured historical windows falls back to histDays for maxDays", () => {
    const plan = computeHistoricalLoadPlan([], 14, false, true);
    assert.strictEqual(plan.maxDays, 14);
  });
});

suite("scopeFilesByRepo", () => {
  test("no scope returns the same map reference", () => {
    const map = new Map<AbsolutePath, number>([[abs("/work/proj/a.ts"), 1]]);
    assert.strictEqual(scopeFilesByRepo(map), map);
  });

  test("scopes to files under the given repo path", () => {
    const map = new Map<AbsolutePath, number>([
      [abs("/work/proj/a.ts"), 1],
      [abs("/work/other/b.ts"), 2],
    ]);
    const result = scopeFilesByRepo(map, "/work/proj");
    assert.deepStrictEqual([...result.keys()], [abs("/work/proj/a.ts")]);
  });

  test("does not match a sibling repo whose name is a prefix", () => {
    const map = new Map<AbsolutePath, number>([[abs("/work/proj2/a.ts"), 1]]);
    const result = scopeFilesByRepo(map, "/work/proj");
    assert.strictEqual(result.size, 0);
  });

  test("matches the repo root path itself", () => {
    const map = new Map<AbsolutePath, number>([[abs("/work/proj"), 1]]);
    const result = scopeFilesByRepo(map, "/work/proj");
    assert.strictEqual(result.size, 1);
  });
});
