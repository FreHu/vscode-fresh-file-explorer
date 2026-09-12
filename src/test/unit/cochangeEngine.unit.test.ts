import * as assert from "assert";

import { computeCochangeSuggestions, CochangeCommit } from "../../cochange/cochangeEngine";

/**
 * Synthetic histories only — shapes mirror real patterns (contract next to
 * implementation, one-shot generated files, ubiquitous locale files) without
 * any real repository data.
 */
suite("cochange engine", () => {
  const commit = (...files: string[]): CochangeCommit => ({ files });
  /** n commits, each touching the given files (plus per-commit extras from `each`). */
  const repeat = (n: number, files: string[], each?: (i: number) => string[]): CochangeCommit[] =>
    Array.from({ length: n }, (_, i) => commit(...files, ...(each?.(i) ?? [])));

  test("suggests the contract file that always accompanies the implementation", () => {
    const history = repeat(6, ["svc/widget.ts", "svc/widgetContract.ts"]);
    const result = computeCochangeSuggestions(history, ["svc/widget.ts"]);

    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(result[0], {
      target: "svc/widgetContract.ts",
      targetKind: "file",
      source: "svc/widget.ts",
      sourceKind: "file",
      together: 6,
      total: 6,
      confidence: 1,
      lastTogetherAt: undefined,
    });
  });

  test("pools thin per-file evidence through the parent directory", () => {
    // Each commit touches a DIFFERENT model file (per-file support 1) plus a
    // one-shot generated file and a shared snapshot — the migration pattern.
    const history = repeat(6, ["schema/snapshot.ts"], i => [`model/m${i}.ts`, `generated/gen${i}.ts`]);
    const result = computeCochangeSuggestions(history, ["model/new.ts"]);

    const targets = result.map(s => `${s.targetKind}:${s.target}`);
    assert.deepStrictEqual(targets, ["file:schema/snapshot.ts", "dir:generated"]);
    // Evidence pooled over the directory: every model commit had both targets.
    assert.ok(result.every(s => s.source === "model" && s.sourceKind === "dir"));
    assert.ok(result.every(s => s.together === 6 && s.total === 6));
  });

  test("a file present in most commits is ubiquitous, not a suggestion", () => {
    const history = [
      ...repeat(30, ["locale/strings.ts"], i => [`feature/f${i}a.ts`, `feature/f${i}b.ts`]),
      ...repeat(2, ["other/x.ts", "other/y.ts"]),
    ];
    const result = computeCochangeSuggestions(history, ["feature/f0a.ts", "feature/other.ts"]);

    assert.ok(!result.some(s => s.target === "locale/strings.ts"),
      `ubiquitous file must not be suggested, got: ${JSON.stringify(result)}`);
  });

  test("bulk commits contribute no evidence", () => {
    const bulkFiles = Array.from({ length: 31 }, (_, i) => `bulk/b${i}.ts`);
    const history = repeat(10, [...bulkFiles, "a/one.ts", "a/two.ts"]);
    const result = computeCochangeSuggestions(history, ["a/one.ts"]);

    assert.deepStrictEqual(result, []);
  });

  test("below the support floor nothing is suggested", () => {
    const history = repeat(2, ["a/one.ts", "a/two.ts"]);
    assert.deepStrictEqual(computeCochangeSuggestions(history, ["a/one.ts"]), []);
  });

  /** Unrelated pair commits that dilute occurrence fractions below the ubiquity cap. */
  const filler = (n: number): CochangeCommit[] =>
    Array.from({ length: n }, (_, i) => commit(`filler${i}/x.ts`, `filler${i}/y.ts`));

  test("below the confidence floor nothing is suggested", () => {
    const history = [
      ...repeat(4, ["a/one.ts", "a/two.ts"]),
      ...repeat(6, ["a/one.ts", "unrelated/z.ts"]),
      ...filler(60), // keep one.ts under the ubiquity cap so confidence is what's tested
    ];
    // one.ts → two.ts is 4/10 = 0.4 < 0.5.
    const result = computeCochangeSuggestions(history, ["a/one.ts"]);
    assert.ok(!result.some(s => s.target === "a/two.ts"));
  });

  test("a target already in the pending set is satisfied, not suggested", () => {
    const history = repeat(6, ["svc/widget.ts", "svc/widgetContract.ts"]);
    const result = computeCochangeSuggestions(history, ["svc/widget.ts", "svc/widgetContract.ts"]);
    assert.deepStrictEqual(result, []);
  });

  test("a dir target with a pending file inside it is satisfied", () => {
    const history = repeat(6, ["schema/snapshot.ts"], i => [`model/m${i}.ts`, `generated/gen${i}.ts`]);
    const result = computeCochangeSuggestions(history, ["model/new.ts", "generated/gen99.ts"]);
    assert.ok(!result.some(s => s.target === "generated"));
    assert.ok(result.some(s => s.target === "schema/snapshot.ts"), "unrelated targets still suggested");
  });

  test("a file never suggests its own parent directory", () => {
    const history = repeat(6, ["a/one.ts", "a/two.ts", "a/three.ts"]);
    const result = computeCochangeSuggestions(history, ["a/one.ts"]);
    assert.ok(!result.some(s => s.targetKind === "dir" && s.target === "a"));
  });

  test("a file→file suggestion subsumes the coarser variants for the same target", () => {
    const history = repeat(6, ["ui/x.ts", "api/y.ts"]);
    const result = computeCochangeSuggestions(history, ["ui/x.ts"]);

    assert.strictEqual(result.length, 1, `expected exactly one suggestion, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result[0].target, "api/y.ts");
    assert.strictEqual(result[0].sourceKind, "file");
  });

  test("respects maxSuggestions and orders deterministically", () => {
    // one.ts co-changes with four overlapping partners at decreasing support
    // (a target only clears the confidence floor if it appears in most of the
    // source's commits — overlap, not disjoint partners).
    const history = [
      ...Array.from({ length: 10 }, (_, i) =>
        commit(
          "hub/one.ts",
          "q1/t1.ts",
          ...(i < 9 ? ["q2/t2.ts"] : []),
          ...(i < 8 ? ["q3/t3.ts"] : []),
          ...(i < 7 ? ["q4/t4.ts"] : []),
        ),
      ),
      ...filler(60), // keep the hub under the ubiquity cap
    ];
    const result = computeCochangeSuggestions(history, ["hub/one.ts"], { maxSuggestions: 3 });

    assert.strictEqual(result.length, 3);
    // Equal granularity → higher confidence/support wins.
    assert.deepStrictEqual(result.map(s => s.together), [10, 9, 8]);
    assert.deepStrictEqual(result.map(s => s.target), ["q1/t1.ts", "q2/t2.ts", "q3/t3.ts"]);
  });

  test("liveness: a coupling that stopped co-changing is filtered out", () => {
    const DAY = 24 * 60 * 60 * 1000;
    // Two independent couplings, both at 100% confidence — one stopped firing.
    const history = [
      ...Array.from({ length: 6 }, (_, i) => ({ files: ["b/two.ts", "x/dead.ts"], at: 100 * DAY + i })),
      ...Array.from({ length: 6 }, (_, i) => ({ files: ["a/one.ts", "y/alive.ts"], at: 300 * DAY + i })),
    ];

    const cutoff = 200 * DAY;
    const result = computeCochangeSuggestions(history, ["a/one.ts", "b/two.ts"], { minLastTogetherAt: cutoff });

    assert.ok(!result.some(s => s.target === "x/dead.ts"), "dead coupling must be filtered");
    const alive = result.find(s => s.target === "y/alive.ts");
    assert.ok(alive, "live coupling survives");
    assert.strictEqual(alive.lastTogetherAt, 300 * DAY + 5, "evidence carries the last co-change date");
  });

  test("liveness filter is inert when history has no timestamps", () => {
    const history = repeat(6, ["a/one.ts", "a/two.ts"]);
    const result = computeCochangeSuggestions(history, ["a/one.ts"], { minLastTogetherAt: Number.MAX_SAFE_INTEGER });
    assert.strictEqual(result.length, 1, "no timestamps → no liveness filtering");
    assert.strictEqual(result[0].lastTogetherAt, undefined);
  });

  test("handles root-level files and empty inputs without crashing", () => {
    assert.deepStrictEqual(computeCochangeSuggestions([], ["a.ts"]), []);
    assert.deepStrictEqual(computeCochangeSuggestions([commit("a.ts", "b.ts")], []), []);
    const result = computeCochangeSuggestions(repeat(6, ["rootA.ts", "rootB.ts"]), ["rootA.ts"]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].target, "rootB.ts");
  });
});
