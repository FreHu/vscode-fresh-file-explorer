import * as assert from "assert";

import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { RepoDiscovery } from "../fresh-files/repoDiscovery";
import { RefreshCancelledError } from "../fresh-files/refreshEpochGuard";
import { DataCollector, RepoInfo } from "../fresh-files/dataCollector";
import { asAbsolutePath, asNormalizedRepoPath } from "../pathTypes";
import { WorkspaceFolderInfo } from "../types";

/**
 * Repo discovery must be runnable on its own — discovery-only consumers (branch
 * compare, blame heatmap) need `onReposReady` without the git-log scan ever running.
 */
suite("repo discovery split", () => {
  const originalDiscover = DataCollector.discoverAllRepos;
  const originalCollectPending = DataCollector.collectPendingFiles;

  let discoverCalls = 0;
  // When set, discovery blocks until resolved — lets a test hold two callers
  // inside the same in-flight walk.
  let discoveryGate: Promise<void> | undefined;

  function fakeRepo(folder: WorkspaceFolderInfo): RepoInfo {
    return {
      folder,
      repoRelPath: "",
      repoFullPath: folder.path,
      normalizedRepoPath: asNormalizedRepoPath(folder.path),
      isUninitialized: false,
    } as RepoInfo;
  }

  function makeProvider(): FreshFileProvider {
    const provider = new FreshFileProvider();
    // Constructor reads the real workspace; pin a synthetic folder so discovery
    // is deterministic and the fake below is the only source of repos.
    provider.workspaceFolders = [{ path: asAbsolutePath("/ws"), name: "ws", gitRepos: [] }];
    return provider;
  }

  setup(() => {
    discoverCalls = 0;
    discoveryGate = undefined;
    DataCollector.discoverAllRepos = async (folders: WorkspaceFolderInfo[]) => {
      discoverCalls++;
      await discoveryGate;
      return { repos: folders.map(fakeRepo), brokenWorktrees: [] };
    };
    // Phase 2 must never run in these tests; blow up loudly if it does.
    DataCollector.collectPendingFiles = async () => {
      throw new Error("collectPendingFiles must not run during discovery-only");
    };
  });

  teardown(() => {
    DataCollector.discoverAllRepos = originalDiscover;
    DataCollector.collectPendingFiles = originalCollectPending;
  });

  test("discovers repos and fires onReposReady without loading files", async () => {
    const provider = makeProvider();
    let readyFired = 0;
    provider.onReposReady(() => readyFired++);

    await provider.ensureReposDiscovered();

    assert.strictEqual(provider.areReposReady, true);
    assert.strictEqual(readyFired, 1);
    assert.deepStrictEqual(provider.getRepoList().map(r => r.path), [asNormalizedRepoPath("/ws")]);
    assert.strictEqual(provider.isDataLoaded, false, "no scan should have run");
  });

  test("leaves no repo stuck in a loading state", async () => {
    const provider = makeProvider();
    await provider.ensureReposDiscovered();

    // Spinner seeding belongs to the load path — discovery alone must not leave
    // per-repo spinners that nothing will ever clear.
    const progress = provider.getLoadingProgress();
    assert.strictEqual(progress.totalRepos, 1);
    assert.strictEqual(progress.loadedRepos, progress.totalRepos);
  });

  test("is idempotent — a second call does not re-walk the workspace", async () => {
    const provider = makeProvider();
    await provider.ensureReposDiscovered();
    await provider.ensureReposDiscovered();

    assert.strictEqual(discoverCalls, 1);
  });

  test("waiters resuming from a cancelled walk share one retry walk", async () => {
    // Regression: with a plain `if` over the in-flight promise, waiters resuming
    // from a cancelled shared walk each started their own concurrent walk and
    // onReposReady fired once per walk (branch compare reloads per fire).
    const folders: WorkspaceFolderInfo[] = [{ path: asAbsolutePath("/ws"), name: "ws", gitRepos: [] }];
    const discovery = new RepoDiscovery({ getWorkspaceFolders: () => folders, onBrokenWorktrees: () => {} });
    let readyFired = 0;
    discovery.onReposReady(() => readyFired++);

    let openGate: () => void = () => {};
    discoveryGate = new Promise<void>(resolve => { openGate = resolve; });

    let cancelled = false;
    const cancellable = () => { if (cancelled) { throw new RefreshCancelledError(); } };
    const live = () => {};

    const first = discovery.discoverRepositories(cancellable).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 0)); // let it enter the gated walk
    const waiterA = discovery.discoverRepositories(live);
    const waiterB = discovery.discoverRepositories(live);

    cancelled = true; // the shared walk throws at its post-walk cancellation check
    openGate();
    await Promise.all([first, waiterA, waiterB]);

    assert.strictEqual(discoverCalls, 2, "one cancelled walk + one shared retry");
    assert.strictEqual(readyFired, 1, "onReposReady must fire exactly once");
    assert.strictEqual(discovery.reposDiscovered, true);
  });

  test("concurrent callers share a single workspace walk", async () => {
    const provider = makeProvider();
    let openGate: () => void = () => {};
    discoveryGate = new Promise<void>(resolve => { openGate = resolve; });

    const first = provider.ensureReposDiscovered();
    const second = provider.ensureReposDiscovered();
    // Let both reach the in-flight walk before letting it finish.
    await new Promise(resolve => setTimeout(resolve, 0));
    openGate();

    await Promise.all([first, second]);

    assert.strictEqual(discoverCalls, 1);
    assert.strictEqual(provider.areReposReady, true);
  });
});
