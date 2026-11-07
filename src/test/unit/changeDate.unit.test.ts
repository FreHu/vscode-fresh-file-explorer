import * as assert from "assert";
import { sortDateOf } from "../../utils/changeDate";

suite("sortDateOf", () => {
  const date = new Date(2026, 0, 1);

  test("committed and pending edits sort by their date", () => {
    assert.strictEqual(sortDateOf({ date }), date);
    assert.strictEqual(sortDateOf({ date, isPending: true }), date);
  });

  test("a pending deletion has no sort date", () => {
    assert.strictEqual(sortDateOf({ date, isPending: true, isDeleted: true }), undefined);
  });
});
