import * as assert from "assert";
import * as vscode from "vscode";

import { RepoHealthNotifier } from "../fresh-files/repoHealthNotifier";
import { ConfigService } from "../config/configService";
import { asNormalizedRepoPath } from "../pathTypes";

suite("commit-graph suggestion", () => {
  const repo = asNormalizedRepoPath("/ws/repo");
  const SLOW = RepoHealthNotifier.SLOW_LOAD_THRESHOLD_MS + 1;

  const originalWarn = ConfigService.getWarnMissingCommitGraph;
  const originalShow = vscode.window.showInformationMessage;
  let toasts = 0;

  setup(() => {
    toasts = 0;
    ConfigService.getWarnMissingCommitGraph = () => true;
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage = (() => {
      toasts++;
      return Promise.resolve(undefined);
    }) as typeof vscode.window.showInformationMessage;
  });

  teardown(() => {
    ConfigService.getWarnMissingCommitGraph = originalWarn;
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage = originalShow;
  });

  const noGraph = async () => false;

  test("toasts for a slow load with no commit-graph", async () => {
    await new RepoHealthNotifier().notifyIfMissingCommitGraph(repo, SLOW, noGraph);
    assert.strictEqual(toasts, 1);
  });

  test("stays quiet below the threshold", async () => {
    await new RepoHealthNotifier().notifyIfMissingCommitGraph(repo, SLOW - 2, noGraph);
    assert.strictEqual(toasts, 0);
  });

  test("stays quiet when a commit-graph exists", async () => {
    await new RepoHealthNotifier().notifyIfMissingCommitGraph(repo, SLOW, async () => true);
    assert.strictEqual(toasts, 0);
  });

  test("respects the warnMissingCommitGraph setting", async () => {
    ConfigService.getWarnMissingCommitGraph = () => false;
    await new RepoHealthNotifier().notifyIfMissingCommitGraph(repo, SLOW, noGraph);
    assert.strictEqual(toasts, 0);
  });

  test("toasts at most once per repo per session", async () => {
    const notifier = new RepoHealthNotifier();
    await notifier.notifyIfMissingCommitGraph(repo, SLOW, noGraph);
    await notifier.notifyIfMissingCommitGraph(repo, SLOW, noGraph);
    assert.strictEqual(toasts, 1);
  });

  test("does not re-run detection for an already-checked repo", async () => {
    const notifier = new RepoHealthNotifier();
    let detections = 0;
    const counting = async () => { detections++; return true; };
    await notifier.notifyIfMissingCommitGraph(repo, SLOW, counting);
    await notifier.notifyIfMissingCommitGraph(repo, SLOW, counting);
    assert.strictEqual(detections, 1);
  });
});
