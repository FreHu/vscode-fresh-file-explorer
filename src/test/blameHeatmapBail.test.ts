import * as assert from "assert";
import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { BlameHeatmapController, BlameHeatmapMode } from "../heatmap/blameHeatmapController";
import { FreshFileProvider } from "../fresh-files/freshFileProvider";
import { BaselineService } from "../baseline/baselineService";
import { ConfigService } from "../config/configService";
import { ContextManager } from "../extension/contextManager";
import { WorkspaceStateManager } from "../extension/workspaceStateManager";
import * as gitCommitQueries from "../git/gitCommitQueries";
import * as blameDiffParsers from "../git/blameDiffParsers";
import * as logger from "../extension/logger";
import { asAbsolutePath } from "../pathTypes";

/**
 * Drives the blame heatmap's apply/bail paths end-to-end against a real
 * TextEditor with the git-query layer stubbed — no live repo. Pins the
 * invariant behind the deletion-marker leak: a bail-out must dispose the
 * file's markers, observable through the deletionLines context key.
 */
suite("blame heatmap bail paths", () => {
  const SHA = "a".repeat(40);
  let tmpDir: string;
  let editor: vscode.TextEditor;
  let provider: FreshFileProvider;
  let controller: BlameHeatmapController;
  /** Last value pushed to the deletionLines context key. */
  let deletionLines: number[] = [];

  // Everything patched, restored in suiteTeardown.
  const orig = {
    isFileTracked: gitCommitQueries.isFileTracked,
    runGitBlamePorcelain: gitCommitQueries.runGitBlamePorcelain,
    getCommitSHAsInRange: gitCommitQueries.getCommitSHAsInRange,
    fileExistsAtRef: gitCommitQueries.fileExistsAtRef,
    getBranchFileDeletedHunks: gitCommitQueries.getBranchFileDeletedHunks,
    parseGitBlamePorcelain: blameDiffParsers.parseGitBlamePorcelain,
    showError: logger.showError,
    autoApply: ConfigService.getBlameHeatmapAutoApply,
    getMode: WorkspaceStateManager.getBlameHeatmapMode,
    setMode: WorkspaceStateManager.setBlameHeatmapMode,
    setDeletionLines: ContextManager.setBlameHeatmapDeletionLines,
  };
  // The compiled CJS module objects are mutable; the type-level casts opt out
  // of TS's read-only view of namespace imports for the duration of the suite.
  const gitQ = gitCommitQueries as {
    isFileTracked: typeof orig.isFileTracked;
    runGitBlamePorcelain: typeof orig.runGitBlamePorcelain;
    getCommitSHAsInRange: typeof orig.getCommitSHAsInRange;
    fileExistsAtRef: typeof orig.fileExistsAtRef;
    getBranchFileDeletedHunks: typeof orig.getBranchFileDeletedHunks;
  };
  const parsers = blameDiffParsers as { parseGitBlamePorcelain: typeof orig.parseGitBlamePorcelain };
  const logMod = logger as { showError: typeof orig.showError };

  const baselineStub = {
    getBaseRef: () => "main",
    getMergeBase: async () => SHA,
    setBaseRef: () => {},
    clearBaseRef: () => {},
  } as unknown as BaselineService;

  suiteSetup(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ffe-blame-"));
    const filePath = path.join(tmpDir, "a.ts");
    fs.writeFileSync(filePath, "line one\nline two\nline three\n");

    // Keep the controller's auto-apply and persistence out of the test.
    ConfigService.getBlameHeatmapAutoApply = () => false;
    WorkspaceStateManager.getBlameHeatmapMode = () => undefined;
    WorkspaceStateManager.setBlameHeatmapMode = () => {};
    ContextManager.setBlameHeatmapDeletionLines = (lines: number[]) => { deletionLines = lines; };
    logMod.showError = () => {};

    // Scripted git scenario: tracked file, one branch commit owning line 1,
    // one pure-deletion hunk after line 2.
    gitQ.isFileTracked = async () => true;
    gitQ.runGitBlamePorcelain = async () => "unused — parser is stubbed";
    parsers.parseGitBlamePorcelain = () => [
      { lineIndex: 0, timestamp: Math.floor(Date.now() / 1000) - 3600, author: "A", summary: "s", sha: SHA },
    ];
    gitQ.getCommitSHAsInRange = async () => new Set([SHA]);
    gitQ.fileExistsAtRef = async () => true;
    gitQ.getBranchFileDeletedHunks = async () => "@@ -3,2 +2,0 @@\n-gone1\n-gone2\n";

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    editor = await vscode.window.showTextDocument(doc);

    provider = new FreshFileProvider();
    // Derive the folder path from the editor's own URI — uri.fsPath normalizes
    // the drive-letter case on Windows, and repo resolution compares prefixes.
    provider.workspaceFolders = [
      { path: asAbsolutePath(path.dirname(editor.document.uri.fsPath)), name: "tmp", gitRepos: [""] },
    ];
    controller = new BlameHeatmapController(provider, baselineStub);
  });

  suiteTeardown(async () => {
    controller.dispose();
    // Release the file handle before deleting the temp dir — Windows throws
    // EBUSY/EPERM while the editor still holds the document.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    gitQ.isFileTracked = orig.isFileTracked;
    gitQ.runGitBlamePorcelain = orig.runGitBlamePorcelain;
    gitQ.getCommitSHAsInRange = orig.getCommitSHAsInRange;
    gitQ.fileExistsAtRef = orig.fileExistsAtRef;
    gitQ.getBranchFileDeletedHunks = orig.getBranchFileDeletedHunks;
    parsers.parseGitBlamePorcelain = orig.parseGitBlamePorcelain;
    logMod.showError = orig.showError;
    ConfigService.getBlameHeatmapAutoApply = orig.autoApply;
    WorkspaceStateManager.getBlameHeatmapMode = orig.getMode;
    WorkspaceStateManager.setBlameHeatmapMode = orig.setMode;
    ContextManager.setBlameHeatmapDeletionLines = orig.setDeletionLines;
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** Reach the private reapply entry point the debounced text-change path uses. */
  const applyToEditor = (mode: BlameHeatmapMode) =>
    (controller as unknown as { applyToEditor(e: vscode.TextEditor, m: BlameHeatmapMode): Promise<void> })
      .applyToEditor(editor, mode);

  test("a successful branch apply installs deletion markers", async () => {
    await controller.applyMode(editor, "branch");

    // Hunk "@@ -3,2 +2,0 @@" anchors after new-file line 2 → context key [2].
    assert.deepStrictEqual(deletionLines, [2]);
    assert.strictEqual(controller.getPickerSnapshot(editor).activeMode, "branch");
  });

  test("a blame failure on reapply disposes the markers and deactivates the file", async () => {
    // The original leak: this bail path dropped the file state but left the
    // marker types alive, so the gutter badges survived indefinitely.
    gitQ.runGitBlamePorcelain = async () => { throw new Error("boom"); };

    await applyToEditor("branch");

    assert.deepStrictEqual(deletionLines, [], "markers must be disposed on bail-out");
    assert.strictEqual(controller.getPickerSnapshot(editor).activeMode, undefined, "file must be deactivated");
  });
});
