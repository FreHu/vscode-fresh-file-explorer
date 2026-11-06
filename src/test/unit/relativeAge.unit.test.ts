import * as assert from "assert";
import { relativeAge } from "../../utils/formatUtils";

const NOW = new Date("2026-06-01T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

suite("relativeAge", () => {
  test("under a minute is now", () => {
    assert.deepStrictEqual(relativeAge(ago(59_999), NOW), { unit: "now", count: 0 });
  });

  test("each bucket starts at its threshold", () => {
    assert.deepStrictEqual(relativeAge(ago(MIN), NOW), { unit: "minute", count: 1 });
    assert.deepStrictEqual(relativeAge(ago(HOUR), NOW), { unit: "hour", count: 1 });
    assert.deepStrictEqual(relativeAge(ago(DAY), NOW), { unit: "day", count: 1 });
    assert.deepStrictEqual(relativeAge(ago(7 * DAY), NOW), { unit: "week", count: 1 });
    assert.deepStrictEqual(relativeAge(ago(30 * DAY), NOW), { unit: "month", count: 1 });
    assert.deepStrictEqual(relativeAge(ago(365 * DAY), NOW), { unit: "year", count: 1 });
  });

  test("each bucket ends just before the next", () => {
    assert.deepStrictEqual(relativeAge(ago(HOUR - 1), NOW), { unit: "minute", count: 59 });
    assert.deepStrictEqual(relativeAge(ago(DAY - 1), NOW), { unit: "hour", count: 23 });
    assert.deepStrictEqual(relativeAge(ago(7 * DAY - 1), NOW), { unit: "day", count: 6 });
    assert.deepStrictEqual(relativeAge(ago(30 * DAY - 1), NOW), { unit: "week", count: 4 });
    assert.deepStrictEqual(relativeAge(ago(360 * DAY - 1), NOW), { unit: "month", count: 11 });
  });
});
