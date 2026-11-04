import * as assert from "assert";
import * as vscode from "vscode";

import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { FreshFileItem } from "../fresh-files/freshFileTreeItems";
import { DataCollector, RepoInfo } from "../fresh-files/dataCollector";
import { asAbsolutePath, asNormalizedRepoPath } from "../pathTypes";
import { WorkspaceFolderInfo } from "../types";

/**
 * Fresh Files opened after repo discovery finished (activation runs discovery only):
 * the first root render starts the load and returns the repo nodes in the same call.
 * VS Code keeps a tree item's first collapsibleState, so a repo rendered as "no files,
 * not loading" there stayed collapsed for good. Seen in the UI, timing-dependent there;
 * deterministic here.
 */
suite("repo node expanded when the view opens after discovery", () => {
  const originalDiscover = DataCollector.discoverAllRepos;
  const originalCollectPending = DataCollector.collectPendingFiles;

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
    // Hold the load open: the render under test happens before any file data arrives.
    DataCollector.collectPendingFiles = () => new Promise(() => {});
  });

  teardown(() => {
    DataCollector.discoverAllRepos = originalDiscover;
    DataCollector.collectPendingFiles = originalCollectPending;
  });

  test("the first root render after discovery shows the repo expanded", async () => {
    const provider = new FreshFileProvider();
    provider.workspaceFolders = [{ path: asAbsolutePath("/ws"), name: "ws", gitRepos: [] }];
    await provider.ensureReposDiscovered();
    assert.strictEqual(provider.isDataLoaded, false, "precondition: discovered, nothing loaded");

    const roots = await provider.getChildren();
    const repo = roots.find((item): item is FreshFileItem => item instanceof FreshFileItem && String(item.id).startsWith("repo:"));
    assert.ok(repo, "a repo node is rendered");
    assert.strictEqual(repo.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
  });
});
