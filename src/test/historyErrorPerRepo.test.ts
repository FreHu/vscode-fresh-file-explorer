import * as assert from "assert";
import * as vscode from "vscode";

import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { FreshFileItem, MessageTreeItem } from "../fresh-files/freshFileTreeItems";
import { DataCollector, RepoInfo } from "../fresh-files/dataCollector";
import { asAbsolutePath, asNormalizedRepoPath } from "../pathTypes";
import { WorkspaceFolderInfo } from "../types";
import { normalizePath } from "../utils";

/** A git log failure in one repo stays on that repo; the other repos render their files. */
suite("history error shown per repo", () => {
  const originalDiscover = DataCollector.discoverAllRepos;
  const originalCollectPendingForRepo = DataCollector.collectPendingForRepo;
  const originalCollectHistoricalForRepo = DataCollector.collectHistoricalForRepo;

  setup(() => {
    DataCollector.discoverAllRepos = async (folders: WorkspaceFolderInfo[]) => ({
      repos: folders.map(folder => ({
        folder,
        repoRelPath: "",
        repoFullPath: folder.path,
        normalizedRepoPath: asNormalizedRepoPath(folder.path),
        isUninitialized: false,
      }) as RepoInfo),
      brokenWorktrees: [],
    });
    DataCollector.collectPendingForRepo = async (folder, _repoRel, targetMap) => {
      targetMap.set(asAbsolutePath(normalizePath(folder.path + "/a.ts")), {
        date: new Date(), status: " M", isPending: true, isDeleted: false,
      });
      return undefined;
    };
    DataCollector.collectHistoricalForRepo = async (folder) => ({
      error: folder.name === "bad" ? { message: "Git error: fatal: unable to read tree", isPathspecError: false } : undefined,
      fullData: new Map(),
    });
  });

  teardown(() => {
    DataCollector.discoverAllRepos = originalDiscover;
    DataCollector.collectPendingForRepo = originalCollectPendingForRepo;
    DataCollector.collectHistoricalForRepo = originalCollectHistoricalForRepo;
  });

  test("the failing repo shows the error, the other repo its files", async () => {
    const provider = new FreshFileProvider();
    provider.workspaceFolders = ["good", "bad"].map(name => ({ path: asAbsolutePath(`/${name}`), name, gitRepos: [] }));
    const historical = provider.timeWindows.find(tw => tw.type === "historical");
    assert.ok(historical, "precondition: a historical time window exists");
    provider.currentTimeWindow = historical; // the pending-only window reads no history
    assert.ok(await provider.ensureDataLoaded(), "precondition: loaded");

    const roots = await provider.getChildren();
    const repos = roots.filter((item): item is FreshFileItem => item instanceof FreshFileItem && String(item.id).startsWith("repo:"));
    assert.deepStrictEqual(repos.map(r => r.label), ["good", "bad"], "both repos render");
    const [good, bad] = repos;

    assert.strictEqual((bad.iconPath as vscode.ThemeIcon).id, "error");
    const badChildren = await provider.getChildren(bad);
    assert.ok(badChildren[0] instanceof MessageTreeItem && String(badChildren[0].label).includes("unable to read tree"));

    assert.notStrictEqual((good.iconPath as vscode.ThemeIcon).id, "error");
    const goodChildren = await provider.getChildren(good);
    assert.ok(goodChildren.length > 0, "the good repo's file is shown");
    assert.ok(goodChildren.every(c => !(c instanceof MessageTreeItem)), "no error under the good repo");
  });
});
