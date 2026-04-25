import * as assert from "assert";
import { parseCommitDate } from "../../git/gitDateUtils";

suite("parseCommitDate", () => {
  test("Z suffix → offset 0", () => {
    const r = parseCommitDate("2024-04-14T19:28:54Z");
    assert.strictEqual(r.tzOffsetMinutes, 0);
    assert.strictEqual(r.date.toISOString(), "2024-04-14T19:28:54.000Z");
  });

  test("+00:00 → offset 0", () => {
    const r = parseCommitDate("2024-04-14T19:28:54+00:00");
    assert.strictEqual(r.tzOffsetMinutes, 0);
  });

  test("positive offset (CEST)", () => {
    const r = parseCommitDate("2024-04-14T19:28:54+02:00");
    assert.strictEqual(r.tzOffsetMinutes, 120);
    // Date is the absolute instant → 17:28:54 UTC
    assert.strictEqual(r.date.toISOString(), "2024-04-14T17:28:54.000Z");
  });

  test("negative offset (US Eastern)", () => {
    const r = parseCommitDate("2024-04-14T08:00:00-05:00");
    assert.strictEqual(r.tzOffsetMinutes, -300);
  });

  test("non-hour offset (India)", () => {
    const r = parseCommitDate("2024-04-14T12:00:00+05:30");
    assert.strictEqual(r.tzOffsetMinutes, 330);
  });

  test("non-hour offset (Nepal)", () => {
    const r = parseCommitDate("2024-04-14T12:00:00+05:45");
    assert.strictEqual(r.tzOffsetMinutes, 345);
  });

  test("compact offset without colon", () => {
    const r = parseCommitDate("2024-04-14T19:28:54+0200");
    assert.strictEqual(r.tzOffsetMinutes, 120);
  });

  test("offset preserves committer's wall-clock hour", () => {
    // A commit at 09:00 in Tokyo (+09:00) — viewers in any TZ should still see 9 as the local hour.
    const r = parseCommitDate("2024-04-14T09:00:00+09:00");
    const localHour = new Date(r.date.getTime() + r.tzOffsetMinutes * 60_000).getUTCHours();
    assert.strictEqual(localHour, 9);
  });

  test("missing offset → defaults to 0 (best-effort)", () => {
    const r = parseCommitDate("2024-04-14T19:28:54");
    assert.strictEqual(r.tzOffsetMinutes, 0);
  });
});
