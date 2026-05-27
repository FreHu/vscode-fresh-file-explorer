import * as vscode from "vscode";

import { Benchmark } from "../benchmark/benchmark";
import { discoverReposInWorkspace, getMergeBase } from "../git/gitOperations";
import {
  fetchCommittedDiff,
  fetchWorkingTreeStatus,
  fetchCommitInfoInRange,
} from "./branchCompareData";

/**
 * Run an array of async ops with a bounded number of concurrent workers.
 * Falls back to sequential when `limit <= 1`, fully parallel when `limit >= ops.length`.
 */
async function runWithLimit<T>(
  ops: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(ops.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, ops.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= ops.length) { return; }
      results[i] = await ops[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

type Strategy = "parallel" | "sequential" | "limit2" | "limit4";

const KNOWN_STRATEGIES: ReadonlySet<string> = new Set<Strategy>([
  "parallel", "sequential", "limit2", "limit4",
]);

/**
 * Benchmark: simulate `BranchCompareProvider.refreshAll` for N comparisons
 * against a single repo, under different concurrency strategies.
 *
 * Per "comparison" we run the same git ops that `refreshComparison` does:
 *  - `git diff --name-status -z mergeBase..HEAD`
 *  - `git status --porcelain=v1 -z`
 *  - (optional) `git log --name-status` for commit-info grouping
 *
 * `mergeBase` is resolved once outside the timed region — mirroring the
 * baseline cache that the real provider keeps. The whole point is to see
 * what 3N concurrent git spawns cost, not to measure merge-base resolution.
 */
export function createBranchCompareRefreshBenchmark(
  workspaceFolders: readonly vscode.WorkspaceFolder[],
): Benchmark {
  return {
    name: "Branch Compare Refresh (concurrency)",
    inputSpec: {
      params: [
        { name: "repoIndex", type: "number", default: 0 },
        { name: "targetRef", type: "string", default: "main" },
        { name: "n", type: "string", default: "1,3,5,10", multi: true },
        {
          name: "strategy",
          type: "string",
          default: "parallel,limit4,limit2,sequential",
          multi: true,
        },
        { name: "withCommitInfo", type: "boolean", default: true },
        { name: "iterations", type: "number", default: 3 },
        { name: "warmup", type: "boolean", default: true },
      ],
    },
    outputSpec: {
      columns: [
        { name: "n", type: "number" },
        { name: "strategy", type: "string" },
        { name: "commitInfo", type: "boolean" },
        { name: "median_ms", type: "number", format: "duration-ms", comparison: "ratioWithPrevious" },
        { name: "min_ms", type: "number", format: "duration-ms" },
        { name: "max_ms", type: "number", format: "duration-ms" },
        { name: "gitProcs", type: "number" },
        { name: "repo", type: "string" },
        { name: "error", type: "string", role: "error" },
      ],
    },
    run: async (inputs) => {
      const repoIndex = Math.max(0, Number(inputs.repoIndex) || 0);
      const target = String(inputs.targetRef || "main");
      const n = Math.max(1, Number(inputs.n) || 1);
      const strategy = String(inputs.strategy) as Strategy;
      const withCommitInfo = Boolean(inputs.withCommitInfo);
      const iterations = Math.max(1, Number(inputs.iterations) || 1);
      const warmup = Boolean(inputs.warmup);

      const baseRow = {
        n,
        strategy,
        commitInfo: withCommitInfo,
        median_ms: 0,
        min_ms: 0,
        max_ms: 0,
        gitProcs: 0,
        repo: "",
      };

      if (!KNOWN_STRATEGIES.has(strategy)) {
        return [{ ...baseRow, error: `Unknown strategy: ${strategy}` }];
      }

      const repos = await discoverReposInWorkspace(workspaceFolders, workspaceFolders.length);
      if (repos.length === 0) {
        return [{ ...baseRow, error: "No git repositories found in workspace" }];
      }
      const repo = repos[Math.min(repoIndex, repos.length - 1)];
      const repoLabel = repo.name;

      let mergeBase: string;
      try {
        mergeBase = await getMergeBase(repo.path, "HEAD", target);
      } catch (err) {
        return [{ ...baseRow, repo: repoLabel, error: `merge-base ${target}: ${err}` }];
      }

      const procsPerOp = withCommitInfo ? 3 : 2;

      const buildOps = (): Array<() => Promise<void>> => {
        const ops: Array<() => Promise<void>> = [];
        for (let i = 0; i < n; i++) {
          ops.push(async () => {
            const tasks: Array<Promise<unknown>> = [
              fetchCommittedDiff(repo.path, mergeBase, "HEAD"),
              fetchWorkingTreeStatus(repo.path),
            ];
            if (withCommitInfo) {
              tasks.push(fetchCommitInfoInRange(repo.path, mergeBase, "HEAD"));
            }
            await Promise.all(tasks);
          });
        }
        return ops;
      };

      const runOnce = async (): Promise<number> => {
        const ops = buildOps();
        const start = Date.now();
        if (strategy === "parallel") {
          await Promise.all(ops.map(op => op()));
        } else if (strategy === "sequential") {
          for (const op of ops) { await op(); }
        } else if (strategy === "limit2") {
          await runWithLimit(ops, 2);
        } else if (strategy === "limit4") {
          await runWithLimit(ops, 4);
        }
        return Date.now() - start;
      };

      try {
        if (warmup) {
          await runOnce();
        }
        const times: number[] = [];
        for (let i = 0; i < iterations; i++) {
          times.push(await runOnce());
        }
        const sorted = [...times].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        return [{
          ...baseRow,
          repo: repoLabel,
          median_ms: median,
          min_ms: sorted[0],
          max_ms: sorted[sorted.length - 1],
          gitProcs: n * procsPerOp,
          error: "",
        }];
      } catch (err) {
        return [{
          ...baseRow,
          repo: repoLabel,
          gitProcs: n * procsPerOp,
          error: String(err),
        }];
      }
    },
  };
}
