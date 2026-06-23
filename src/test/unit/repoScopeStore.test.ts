import * as assert from "assert";
import * as vscode from "vscode";

import { RepoScopeStore } from "../../fresh-files/repoScopeStore";
import { WorkspaceStateManager } from "../../extension/workspaceStateManager";
import { RepoInfo } from "../../fresh-files/dataCollector";
import { asNormalizedRepoPath } from "../../pathTypes";

/**
 * In-memory `vscode.ExtensionContext` whose `workspaceState` is a Map — lets us
 * exercise RepoScopeStore's persistence without an extension host. Same pattern
 * as savedComparisonsService.test.ts.
 */
function makeFakeContext(seed?: Record<string, unknown>): vscode.ExtensionContext {
  const store = new Map<string, unknown>(Object.entries(seed ?? {}));
  return {
    workspaceState: {
      get(key: string, fallback?: unknown) {
        return store.has(key) ? store.get(key) : fallback;
      },
      update(key: string, value: unknown): Thenable<void> {
        if (value === undefined) { store.delete(key); } else { store.set(key, value); }
        return Promise.resolve();
      },
      keys(): readonly string[] { return [...store.keys()]; },
      setKeysForSync() { /* no-op */ },
    },
  } as unknown as vscode.ExtensionContext;
}

const REPO_A = asNormalizedRepoPath("/repos/alpha");
const REPO_B = asNormalizedRepoPath("/repos/bravo");

/** Minimal RepoInfo — passesScope only reads `normalizedRepoPath`. */
function repo(normalizedRepoPath: ReturnType<typeof asNormalizedRepoPath>): RepoInfo {
  return { normalizedRepoPath } as RepoInfo;
}

suite("RepoScopeStore", () => {
  suite("load + persistence", () => {
    test("load() round-trips seeded pathspecs and folder scopes", () => {
      WorkspaceStateManager.initialize(makeFakeContext({
        repoPathspecs: { [REPO_A]: "src/*.ts" },
        repoFolderScopes: { [REPO_B]: "/repos/bravo/pkg" },
      }));
      const store = new RepoScopeStore();
      store.load();

      assert.strictEqual(store.getPathspec(REPO_A), "src/*.ts");
      assert.strictEqual(store.getFolderScope(REPO_B), "/repos/bravo/pkg");
      assert.strictEqual(store.getPathspec(REPO_B), undefined);
    });

    test("setPathspec persists across a fresh load on the same context", () => {
      const ctx = makeFakeContext();
      WorkspaceStateManager.initialize(ctx);
      const store = new RepoScopeStore();
      store.load();

      store.setPathspec(REPO_A, "lib/**");
      assert.strictEqual(store.getPathspec(REPO_A), "lib/**");

      // A new store reading the same persisted context sees the value.
      const reloaded = new RepoScopeStore();
      reloaded.load();
      assert.strictEqual(reloaded.getPathspec(REPO_A), "lib/**");
    });

    test("setPathspec(undefined) clears and persists the removal", () => {
      WorkspaceStateManager.initialize(makeFakeContext({ repoPathspecs: { [REPO_A]: "src/*.ts" } }));
      const store = new RepoScopeStore();
      store.load();

      store.setPathspec(REPO_A, undefined);
      assert.strictEqual(store.getPathspec(REPO_A), undefined);

      const reloaded = new RepoScopeStore();
      reloaded.load();
      assert.strictEqual(reloaded.getPathspec(REPO_A), undefined);
    });

    test("setFolderScope persists and clears", () => {
      WorkspaceStateManager.initialize(makeFakeContext());
      const store = new RepoScopeStore();
      store.load();

      store.setFolderScope(REPO_A, "/repos/alpha/sub");
      assert.strictEqual(store.getFolderScope(REPO_A), "/repos/alpha/sub");
      assert.strictEqual(store.hasFolderScopes(), true);

      store.setFolderScope(REPO_A, undefined);
      assert.strictEqual(store.getFolderScope(REPO_A), undefined);
      assert.strictEqual(store.hasFolderScopes(), false);
    });

    test("pathspecs getter exposes the live map", () => {
      WorkspaceStateManager.initialize(makeFakeContext({ repoPathspecs: { [REPO_A]: "x", [REPO_B]: "y" } }));
      const store = new RepoScopeStore();
      store.load();
      assert.deepStrictEqual([...store.pathspecs.entries()].sort(), [[REPO_A, "x"], [REPO_B, "y"]]);
    });
  });

  suite("passesScope", () => {
    setup(() => {
      WorkspaceStateManager.initialize(makeFakeContext());
    });

    const repos = [repo(REPO_A), repo(REPO_B)];

    test("everything passes when no folder scope is set", () => {
      const store = new RepoScopeStore();
      store.load();
      assert.strictEqual(store.passesScope("/repos/alpha/anything.ts", repos), true);
    });

    test("file inside the scoped folder passes; sibling outside is rejected", () => {
      const store = new RepoScopeStore();
      store.load();
      store.setFolderScope(REPO_A, "/repos/alpha/src");

      assert.strictEqual(store.passesScope("/repos/alpha/src/deep/file.ts", repos), true);
      assert.strictEqual(store.passesScope("/repos/alpha/src", repos), true);        // the scope dir itself
      assert.strictEqual(store.passesScope("/repos/alpha/test/file.ts", repos), false);
    });

    test("scope on one repo does not constrain a different, unscoped repo", () => {
      const store = new RepoScopeStore();
      store.load();
      store.setFolderScope(REPO_A, "/repos/alpha/src");

      // REPO_B has no scope → its files always pass even while REPO_A is scoped.
      assert.strictEqual(store.passesScope("/repos/bravo/anywhere.ts", repos), true);
    });

    test("a path not owned by any known repo passes", () => {
      const store = new RepoScopeStore();
      store.load();
      store.setFolderScope(REPO_A, "/repos/alpha/src");
      assert.strictEqual(store.passesScope("/elsewhere/file.ts", repos), true);
    });
  });
});
