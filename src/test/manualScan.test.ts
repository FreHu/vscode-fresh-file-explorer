import * as assert from "assert";
import * as vscode from "vscode";

import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { DataCollector, RepoInfo } from "../fresh-files/dataCollector";
import { ConfigService } from "../config/configService";
import { ConfigKeys } from "../config/configKeyConstants";
import { ContextKeys } from "../extension/contextKeyConstants";
import { handleSearchInFreshFiles } from "../commands/searchCommand";
import { handleRefresh, handleToggleHeatmap } from "../commands/basicCommands";
import { handleFilterByAuthor } from "../commands/filterCommands";
import { HeatmapDecorationProvider } from "../heatmap/heatmapDecorationProvider";
import { asAbsolutePath, asNormalizedRepoPath } from "../pathTypes";
import { WorkspaceFolderInfo } from "../types";

/**
 * Manual scan: no git history is read until an explicit Refresh arms the scan.
 * Repo discovery must still run, or branch compare and the blame heatmap go dark.
 */
suite("manual scan mode", () => {
  const originalDiscover = DataCollector.discoverAllRepos;
  const originalCollectPending = DataCollector.collectPendingFiles;
  const originalCollectPendingForRepo = DataCollector.collectPendingForRepo;
  const originalCollectHistoricalForRepo = DataCollector.collectHistoricalForRepo;
  const originalLoadingMode = ConfigService.getFreshFileLoadingMode;

  let historyReads = 0;
  let discoverCalls = 0;
  // Repo paths whose history was actually read, to catch loads scoped too narrowly.
  let historyRepoPaths: string[] = [];
  // When set, pending collection blocks until resolved — holds a load mid-flight.
  let loadGate: Promise<void> | undefined;

  function fakeRepo(folder: WorkspaceFolderInfo): RepoInfo {
    return {
      folder,
      repoRelPath: "",
      repoFullPath: folder.path,
      normalizedRepoPath: asNormalizedRepoPath(folder.path),
      isUninitialized: false,
    } as RepoInfo;
  }

  function makeProvider(manualScan: boolean, folderPaths = ["/ws"]): FreshFileProvider {
    ConfigService.getFreshFileLoadingMode = () => (manualScan ? "manual" : "startup");
    const provider = new FreshFileProvider();
    provider.workspaceFolders = folderPaths.map(p => ({ path: asAbsolutePath(p), name: p.slice(1), gitRepos: [] }));
    return provider;
  }

  /** Let the fire-and-forget discovery / load paths settle. */
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));

  setup(() => {
    historyReads = 0;
    discoverCalls = 0;
    historyRepoPaths = [];
    loadGate = undefined;
    DataCollector.discoverAllRepos = async (folders: WorkspaceFolderInfo[]) => {
      discoverCalls++;
      return { repos: folders.map(fakeRepo), brokenWorktrees: [] };
    };
    // Every path that reads git history, so a leak through any of them is caught
    // (the tree load uses the per-repo pair; refreshPending uses the batch call).
    DataCollector.collectPendingFiles = async () => {
      historyReads++;
      return { files: new Map(), removedPaths: [] };
    };
    DataCollector.collectPendingForRepo = async (folder) => {
      historyReads++;
      historyRepoPaths.push(folder.path);
      await loadGate;
      return undefined;
    };
    DataCollector.collectHistoricalForRepo = async () => {
      historyReads++;
      return { error: undefined, fullData: new Map() };
    };
  });

  teardown(() => {
    DataCollector.discoverAllRepos = originalDiscover;
    DataCollector.collectPendingFiles = originalCollectPending;
    DataCollector.collectPendingForRepo = originalCollectPendingForRepo;
    DataCollector.collectHistoricalForRepo = originalCollectHistoricalForRepo;
    ConfigService.getFreshFileLoadingMode = originalLoadingMode;
  });

  test("dormant while manual scan is on and unarmed", () => {
    assert.strictEqual(makeProvider(true).isScanDormant, true);
    assert.strictEqual(makeProvider(false).isScanDormant, false);
  });

  test("rendering the tree discovers repos but reads no history", async () => {
    const provider = makeProvider(true);

    await provider.getChildren();
    await settle();

    assert.strictEqual(historyReads, 0, "no git history should be read while dormant");
    assert.strictEqual(provider.areReposReady, true, "discovery must still run");
    assert.strictEqual(provider.isDataLoaded, false);

    // The first render lands before async discovery finishes; the re-render after
    // it is the one that must offer the scan rather than a list of empty repos.
    const children = await provider.getChildren();
    assert.strictEqual(children.length, 1);
    assert.ok((children[0].label as string).includes("click to load"));
  });

  test("reports a dormant loading state rather than a stuck spinner", async () => {
    const provider = makeProvider(true);
    await provider.getChildren();
    await settle();

    const progress = provider.getLoadingProgress();
    assert.strictEqual(progress.state, "dormant");
    assert.strictEqual(progress.totalRepos, 1);
  });

  test("re-rendering while dormant does not fire more tree events", async () => {
    // getChildren hits the dormant path on every root render (dataLoaded is always
    // false), so firing a tree event from there re-enters getChildren and spins the
    // view's progress indicator forever.
    const provider = makeProvider(true);
    await provider.getChildren();
    await settle();

    let fires = 0;
    provider.onDidChangeTreeData(() => fires++);
    for (let i = 0; i < 5; i++) {
      await provider.getChildren();
    }
    await settle();

    assert.strictEqual(fires, 0);
  });

  test("working-tree refreshes are suppressed while dormant", async () => {
    const provider = makeProvider(true);
    await provider.refreshPending();
    await settle();

    assert.strictEqual(historyReads, 0);
    assert.strictEqual(provider.isDataLoaded, false);
  });

  test("git-state refreshes are suppressed while dormant", async () => {
    const provider = makeProvider(true);
    provider.refresh();
    provider.hardRefresh();
    await settle();

    assert.strictEqual(historyReads, 0);
  });

  test("arming is sticky — later automatic refreshes load normally", async () => {
    const provider = makeProvider(true);
    provider.armScan();
    provider.hardRefresh();
    await settle();

    assert.strictEqual(provider.isScanDormant, false);
    assert.ok(historyReads > 0, "history should load once armed");

    const readsAfterArm = historyReads;
    await provider.refreshPending();
    await settle();
    assert.ok(historyReads > readsAfterArm, "pending refresh should no longer be gated");
  });

  test("ensureDataLoaded arms — it is only reached by explicit user actions", async () => {
    const provider = makeProvider(true);
    await provider.ensureDataLoaded();

    assert.strictEqual(provider.isScanDormant, false);
    assert.ok(historyReads > 0);
  });

  test("heatmap file decorations do not arm the scan", async () => {
    // VS Code polls the decoration provider for every visible file right after
    // activation, so this path must stay gated — otherwise manual scan is a no-op
    // for anyone with the heatmap enabled.
    const originalHeatmapEnabled = ConfigService.isHeatmapEnabled;
    ConfigService.isHeatmapEnabled = () => true;
    try {
      const provider = makeProvider(true);
      provider.currentTimeWindow = { type: "historical", label: "1 year", days: 365 };
      const decorations = new HeatmapDecorationProvider(provider);

      const result = await decorations.provideFileDecoration(vscode.Uri.file("/ws/src/a.ts"));
      await settle();

      assert.strictEqual(result, undefined);
      assert.strictEqual(provider.isScanDormant, true, "decoration polling must not arm the scan");
      assert.strictEqual(historyReads, 0);
    } finally {
      ConfigService.isHeatmapEnabled = originalHeatmapEnabled;
    }
  });

  test("an explicit search arms the scan instead of reporting no files", async () => {
    const provider = makeProvider(true);
    await handleSearchInFreshFiles(provider);

    assert.strictEqual(provider.isScanDormant, false);
    assert.ok(historyReads > 0);
  });

  test("arming does not re-walk the workspace that activation already discovered", async () => {
    const provider = makeProvider(true);
    await provider.ensureReposDiscovered(); // what activation does
    assert.strictEqual(discoverCalls, 1);

    handleRefresh(provider);
    await settle();

    assert.strictEqual(discoverCalls, 1, "arming should not re-discover");
    assert.ok(historyReads > 0, "but it must still load history");
  });

  test("a later refresh still re-discovers, once armed", async () => {
    const provider = makeProvider(true);
    await provider.ensureReposDiscovered();
    handleRefresh(provider);
    await settle();

    handleRefresh(provider);
    await settle();

    assert.strictEqual(discoverCalls, 2, "the repo list may have changed by then");
  });

  test("enabling the heatmap loads the data its colors come from", async () => {
    const originalSet = ConfigService.setHeatmapEnabled;
    const originalEnabled = ConfigService.isHeatmapEnabled;
    let enabled = false;
    ConfigService.isHeatmapEnabled = () => enabled;
    ConfigService.setHeatmapEnabled = async (v: boolean) => { enabled = v; };
    try {
      const provider = makeProvider(true);
      await handleToggleHeatmap(provider);
      await settle();

      assert.strictEqual(provider.isScanDormant, false);
      assert.ok(historyReads > 0, "enabling must not be a silent no-op");
    } finally {
      ConfigService.isHeatmapEnabled = originalEnabled;
      ConfigService.setHeatmapEnabled = originalSet;
    }
  });

  test("filtering by author loads rather than claiming there are none", async () => {
    const provider = makeProvider(true);
    await handleFilterByAuthor(provider);

    assert.strictEqual(provider.isScanDormant, false);
    assert.ok(historyReads > 0);
  });

  test("turning manual scan on mid-load does not restart the cancelled load", async () => {
    // The cancelled load's stale-load re-kick must re-check dormancy, or the
    // setting is defeated the moment it's turned on during a scan.
    const provider = makeProvider(false);
    let manual = false;
    ConfigService.getFreshFileLoadingMode = () => (manual ? "manual" : "startup"); // after makeProvider, which pins a fixed value
    let openGate: () => void = () => {};
    loadGate = new Promise<void>(resolve => { openGate = resolve; });

    provider.hardRefresh();
    await new Promise(resolve => setTimeout(resolve, 0)); // let the load reach the gate

    manual = true;
    provider.onConfigurationChanged({
      affectsConfiguration: (section: string) => section === ConfigKeys.FRESH_FILE_LOADING,
    } as vscode.ConfigurationChangeEvent);

    openGate();
    await settle();

    assert.strictEqual(provider.isScanDormant, true);
    assert.strictEqual(provider.isDataLoaded, false, "the cancelled load must not silently rerun");
  });

  test("a targeted refresh parked by dormancy does not scope the first armed load", async () => {
    // An ambient targeted refresh (e.g. a commit noticed by the git listener) dead-ends
    // at the dormant gate — its repo scope must not survive into the load the user
    // eventually asks for, or every other repo would come up empty.
    const provider = makeProvider(true, ["/ws1", "/ws2"]);
    await provider.ensureReposDiscovered();

    provider.refresh({ targetRepoPaths: [asNormalizedRepoPath("/ws2")] });
    await settle();
    assert.strictEqual(historyReads, 0, "still dormant");

    await provider.ensureDataLoaded();

    const loaded = new Set(historyRepoPaths);
    assert.ok(loaded.has("/ws1") && loaded.has("/ws2"), `armed load must cover all repos, got: ${[...loaded].join(", ")}`);
  });

  test("the loading context key is not left stuck while dormant", async () => {
    // `dataLoaded` stays false in dormant mode, so the provider has to clear the
    // context key itself — three package.json `when` clauses depend on it.
    const provider = makeProvider(true);
    const setContextCalls: { key: unknown; value: unknown }[] = [];
    const originalExecute = vscode.commands.executeCommand;
    (vscode.commands as { executeCommand: unknown }).executeCommand = ((cmd: string, key: unknown, value: unknown) => {
      if (cmd === "setContext") { setContextCalls.push({ key, value }); }
      return originalExecute.call(vscode.commands, cmd as never, key as never, value as never);
    }) as typeof vscode.commands.executeCommand;

    try {
      await provider.getChildren();
      await settle();
    } finally {
      (vscode.commands as { executeCommand: unknown }).executeCommand = originalExecute;
    }

    const loadingCalls = setContextCalls.filter(c => c.key === ContextKeys.LOADING);
    assert.strictEqual(loadingCalls.at(-1)?.value, false, "loading must be cleared in dormant mode");
  });
});
