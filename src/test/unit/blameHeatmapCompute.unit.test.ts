import * as assert from "assert";
import type { BlameLineInfo } from "../../git/blameDiffParsers";
import {
  computeBranchWindow,
  computeAbsoluteWindow,
  detectAllNewFile,
  clampDeletionLineIndex,
} from "../../heatmap/blameHeatmapCompute";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000; // fixed reference so tests are deterministic

function line(partial: Partial<BlameLineInfo> & { sha: string; timestamp: number }): BlameLineInfo {
  return { lineIndex: 0, author: "a", summary: "s", ...partial };
}

suite("blameHeatmapCompute", () => {
  suite("computeAbsoluteWindow", () => {
    test("window spans from the oldest line to now", () => {
      const oldest = Math.floor((NOW - 10 * DAY) / 1000);
      const recent = Math.floor((NOW - 1 * DAY) / 1000);
      const { windowDays } = computeAbsoluteWindow(
        [line({ sha: "a", timestamp: oldest }), line({ sha: "b", timestamp: recent })],
        NOW,
      );
      assert.ok(Math.abs(windowDays - 10) < 0.01, `expected ~10, got ${windowDays}`);
    });

    test("window is clamped to a minimum of 1 day", () => {
      const justNow = Math.floor(NOW / 1000);
      const { windowDays } = computeAbsoluteWindow([line({ sha: "a", timestamp: justNow })], NOW);
      assert.strictEqual(windowDays, 1);
    });

    test("getBucket assigns every line a non-negative bucket (no skip in absolute mode)", () => {
      const ts = Math.floor((NOW - 5 * DAY) / 1000);
      const { getBucket } = computeAbsoluteWindow([line({ sha: "a", timestamp: ts })], NOW);
      assert.ok(getBucket("anything", ts) >= 0);
    });
  });

  suite("computeBranchWindow", () => {
    test("only branch-commit lines get a bucket; others return the -1 skip sentinel", () => {
      const ts = Math.floor((NOW - 3 * DAY) / 1000);
      const branchShas = new Set(["branch1"]);
      const { getBucket } = computeBranchWindow(
        [line({ sha: "branch1", timestamp: ts }), line({ sha: "old", timestamp: ts })],
        branchShas,
        NOW,
      );
      assert.ok(getBucket("branch1", ts) >= 0);
      assert.strictEqual(getBucket("old", ts), -1);
    });

    test("window anchors on the oldest branch line in the file, ignoring non-branch lines", () => {
      const oldNonBranch = Math.floor((NOW - 100 * DAY) / 1000);
      const oldestBranch = Math.floor((NOW - 7 * DAY) / 1000);
      const { windowDays, branchLinesInFile } = computeBranchWindow(
        [line({ sha: "old", timestamp: oldNonBranch }), line({ sha: "b", timestamp: oldestBranch })],
        new Set(["b"]),
        NOW,
      );
      assert.ok(Math.abs(windowDays - 7) < 0.01, `expected ~7, got ${windowDays}`);
      assert.strictEqual(branchLinesInFile, 1);
    });

    test("no branch lines in file → window irrelevant, clamped to 1 day", () => {
      const { windowDays, branchLinesInFile } = computeBranchWindow(
        [line({ sha: "old", timestamp: Math.floor((NOW - 50 * DAY) / 1000) })],
        new Set(["other"]),
        NOW,
      );
      assert.strictEqual(windowDays, 1);
      assert.strictEqual(branchLinesInFile, 0);
    });
  });

  suite("detectAllNewFile", () => {
    const ts = Math.floor(NOW / 1000);
    const branch = new Set(["b"]);

    test("all lines from branch, did not exist at merge base, no deletions → new file", () => {
      const lines = [line({ sha: "b", timestamp: ts }), line({ sha: "b", timestamp: ts })];
      assert.strictEqual(detectAllNewFile(lines, branch, false, false), true);
    });

    test("existed at merge base (fully rewritten) → NOT new", () => {
      const lines = [line({ sha: "b", timestamp: ts })];
      assert.strictEqual(detectAllNewFile(lines, branch, true, false), false);
    });

    test("has deletion hunks → NOT new", () => {
      const lines = [line({ sha: "b", timestamp: ts })];
      assert.strictEqual(detectAllNewFile(lines, branch, false, true), false);
    });

    test("a non-branch line present → NOT new", () => {
      const lines = [line({ sha: "b", timestamp: ts }), line({ sha: "old", timestamp: ts })];
      assert.strictEqual(detectAllNewFile(lines, branch, false, false), false);
    });
  });

  suite("clampDeletionLineIndex", () => {
    test("converts 1-based anchor to 0-based index", () => {
      assert.strictEqual(clampDeletionLineIndex(5, 100), 4);
    });

    test("anchor of 0 (before first line) clamps to 0", () => {
      assert.strictEqual(clampDeletionLineIndex(0, 100), 0);
    });

    test("anchor past EOF clamps to last line", () => {
      assert.strictEqual(clampDeletionLineIndex(999, 10), 9);
    });
  });
});
