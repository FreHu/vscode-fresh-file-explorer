import * as assert from "assert";
import { aggregateStonksData } from "../../stonks/stonksDataCollector";
import type { StonksDataPoint } from "../../webview/messages";

function pt(date: string, overrides?: Partial<StonksDataPoint>): StonksDataPoint {
  return {
    hash: "abc123",
    author: "dev",
    date,
    message: "commit",
    filesChanged: 1,
    filesAdded: 1,
    filesDeleted: 0,
    cumulativeFileCount: 100,
    commitCount: 1,
    ...overrides,
  };
}

suite("aggregateStonksData", () => {
  test("commit mode returns data as-is", () => {
    const data = [pt("2025-03-10T12:00:00Z"), pt("2025-03-11T12:00:00Z")];
    const result = aggregateStonksData(data, "commit");
    assert.strictEqual(result, data);
  });

  test("day mode buckets by calendar day", () => {
    const data = [
      pt("2025-03-10T08:00:00Z", { filesChanged: 2, filesAdded: 1, filesDeleted: 1, cumulativeFileCount: 100 }),
      pt("2025-03-10T16:00:00Z", { filesChanged: 3, filesAdded: 2, filesDeleted: 1, cumulativeFileCount: 105 }),
      pt("2025-03-11T10:00:00Z", { filesChanged: 1, filesAdded: 1, filesDeleted: 0, cumulativeFileCount: 106 }),
    ];
    const result = aggregateStonksData(data, "day");
    assert.strictEqual(result.length, 2);

    // First bucket: 2025-03-10
    assert.strictEqual(result[0].filesChanged, 5);
    assert.strictEqual(result[0].filesAdded, 3);
    assert.strictEqual(result[0].filesDeleted, 2);
    assert.strictEqual(result[0].cumulativeFileCount, 105); // last value
    assert.strictEqual(result[0].commitCount, 2);
    assert.strictEqual(result[0].hash, undefined);
    assert.strictEqual(result[0].author, undefined);
    assert.strictEqual(result[0].message, undefined);

    // Second bucket: 2025-03-11
    assert.strictEqual(result[1].commitCount, 1);
    assert.strictEqual(result[1].cumulativeFileCount, 106);
  });

  test("week mode buckets by ISO week (Monday start)", () => {
    // 2025-03-10 is a Monday, 2025-03-16 is a Sunday (same week)
    // 2025-03-17 is a Monday (next week)
    const data = [
      pt("2025-03-10T12:00:00Z"),
      pt("2025-03-16T12:00:00Z"),
      pt("2025-03-17T12:00:00Z"),
    ];
    const result = aggregateStonksData(data, "week");
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].commitCount, 2); // Mon-Sun
    assert.strictEqual(result[1].commitCount, 1); // next Mon
  });

  test("month mode buckets by calendar month", () => {
    const data = [
      pt("2025-01-15T12:00:00Z"),
      pt("2025-01-25T12:00:00Z"),
      pt("2025-02-05T12:00:00Z"),
    ];
    const result = aggregateStonksData(data, "month");
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].commitCount, 2); // January
    assert.strictEqual(result[1].commitCount, 1); // February
  });

  test("empty input returns empty output", () => {
    assert.deepStrictEqual(aggregateStonksData([], "day"), []);
    assert.deepStrictEqual(aggregateStonksData([], "week"), []);
    assert.deepStrictEqual(aggregateStonksData([], "month"), []);
  });

  test("bucket date is start of period", () => {
    const data = [pt("2025-03-15T14:30:00Z")];

    const dayResult = aggregateStonksData(data, "day");
    assert.strictEqual(new Date(dayResult[0].date).toISOString(), "2025-03-15T00:00:00.000Z");

    const weekResult = aggregateStonksData(data, "week");
    // 2025-03-15 is Saturday, week starts Monday 2025-03-10
    assert.strictEqual(new Date(weekResult[0].date).toISOString(), "2025-03-10T00:00:00.000Z");

    const monthResult = aggregateStonksData(data, "month");
    assert.strictEqual(new Date(monthResult[0].date).toISOString(), "2025-03-01T00:00:00.000Z");
  });
});
