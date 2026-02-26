import * as assert from "assert";
import { buildCommitItems, buildAuthorItems, buildTimeWindowItems } from "../../utils/quickPick";
import { asCommitHash } from "../../types";
import type { CommitDataWithFileCount, AuthorData } from "../../types";
import type { TimeWindow } from "../../fresh-files/timeWindowUtils";

// ── fixtures ──────────────────────────────────────────────────────────────────

const HASH_A = asCommitHash("aaa0000");
const HASH_B = asCommitHash("bbb1111");

const COMMITS: CommitDataWithFileCount[] = [
  { hash: HASH_A, message: "feat: add foo" as any, author: "Alice" as any, date: new Date("2025-01-01"), fileCount: 3 },
  { hash: HASH_B, message: "fix: remove bar" as any, author: "Bob" as any, date: new Date("2025-01-02"), repoName: "backend", fileCount: 1 },
];

const AUTHORS: AuthorData[] = [
  { author: "Alice" as any, fileCount: 5 },
  { author: "Bob" as any, fileCount: 2 },
];

const TW_PENDING: TimeWindow = { type: "pending", label: "Pending" };
const TW_7: TimeWindow = { type: "historical", label: "7 days", days: 7 };
const TW_30: TimeWindow = { type: "historical", label: "30 days", days: 30 };
const TIME_WINDOWS: TimeWindow[] = [TW_PENDING, TW_7, TW_30];

// ── buildCommitItems ──────────────────────────────────────────────────────────

suite("buildCommitItems", () => {
  test("returns one item per commit", () => {
    const items = buildCommitItems(COMMITS);
    assert.strictEqual(items.length, 2);
  });

  test("each item carries the commit hash", () => {
    const items = buildCommitItems(COMMITS);
    assert.strictEqual(items[0].hash, HASH_A);
    assert.strictEqual(items[1].hash, HASH_B);
  });

  test("all items are picked when no exclusions are provided", () => {
    const items = buildCommitItems(COMMITS);
    assert.ok(items.every(i => i.picked));
  });

  test("excluded commits have picked = false", () => {
    const items = buildCommitItems(COMMITS, new Set([HASH_A]));
    assert.strictEqual(items[0].picked, false);
    assert.strictEqual(items[1].picked, true);
  });

  test("description includes file count and author", () => {
    const items = buildCommitItems(COMMITS);
    assert.ok(items[0].description!.includes("3 file(s)"));
    assert.ok(items[0].description!.includes("Alice"));
  });

  test("description includes repo name when present", () => {
    const items = buildCommitItems(COMMITS);
    assert.ok(items[1].description!.includes("[backend]"));
    assert.ok(!items[0].description!.includes("["));
  });

  test("detail contains the commit message", () => {
    const items = buildCommitItems(COMMITS);
    assert.ok(items[0].detail!.includes("feat: add foo"));
  });

  test("returns empty array for empty input", () => {
    assert.deepStrictEqual(buildCommitItems([]), []);
  });
});

// ── buildAuthorItems ─────────────────────────────────────────────────────────

suite("buildAuthorItems", () => {
  test("returns one item per author", () => {
    const items = buildAuthorItems(AUTHORS);
    assert.strictEqual(items.length, 2);
  });

  test("each item carries the author name", () => {
    const items = buildAuthorItems(AUTHORS);
    assert.strictEqual(items[0].author, "Alice");
    assert.strictEqual(items[1].author, "Bob");
  });

  test("label matches author name", () => {
    const items = buildAuthorItems(AUTHORS);
    assert.strictEqual(items[0].label, "Alice");
  });

  test("all items are picked when no exclusions are provided", () => {
    const items = buildAuthorItems(AUTHORS);
    assert.ok(items.every(i => i.picked));
  });

  test("excluded authors have picked = false", () => {
    const items = buildAuthorItems(AUTHORS, new Set(["Alice"]));
    assert.strictEqual(items[0].picked, false);
    assert.strictEqual(items[1].picked, true);
  });

  test("description includes file count", () => {
    const items = buildAuthorItems(AUTHORS);
    assert.ok(items[0].description!.includes("5 file(s)"));
    assert.ok(items[1].description!.includes("2 file(s)"));
  });

  test("returns empty array for empty input", () => {
    assert.deepStrictEqual(buildAuthorItems([]), []);
  });
});

// ── buildTimeWindowItems ─────────────────────────────────────────────────────

suite("buildTimeWindowItems", () => {
  test("returns one item per time window", () => {
    const items = buildTimeWindowItems(TIME_WINDOWS, TW_7);
    assert.strictEqual(items.length, 3);
  });

  test("each item carries the time window object", () => {
    const items = buildTimeWindowItems(TIME_WINDOWS, TW_7);
    assert.strictEqual(items[0].timeWindow, TW_PENDING);
    assert.strictEqual(items[1].timeWindow, TW_7);
    assert.strictEqual(items[2].timeWindow, TW_30);
  });

  test("label matches the time window label", () => {
    const items = buildTimeWindowItems(TIME_WINDOWS, TW_7);
    assert.strictEqual(items[0].label, "Pending");
    assert.strictEqual(items[1].label, "7 days");
  });

  test("only the current time window is picked", () => {
    const items = buildTimeWindowItems(TIME_WINDOWS, TW_7);
    assert.strictEqual(items[0].picked, false);
    assert.strictEqual(items[1].picked, true);
    assert.strictEqual(items[2].picked, false);
  });

  test("pending window is recognised as current", () => {
    const items = buildTimeWindowItems(TIME_WINDOWS, TW_PENDING);
    assert.strictEqual(items[0].picked, true);
    assert.ok(!items.slice(1).some(i => i.picked));
  });

  test("current item description is marked accordingly", () => {
    const items = buildTimeWindowItems(TIME_WINDOWS, TW_7);
    assert.ok(items[1].description!.includes("current"));
  });

  test("non-current historical item description mentions days", () => {
    const items = buildTimeWindowItems(TIME_WINDOWS, TW_7);
    assert.ok(items[2].description!.includes("30"));
  });

  test("non-current pending item description mentions pending/uncommitted", () => {
    const items = buildTimeWindowItems(TIME_WINDOWS, TW_7);
    const desc = items[0].description!.toLowerCase();
    assert.ok(desc.includes("uncommitted") || desc.includes("pending"));
  });
});
