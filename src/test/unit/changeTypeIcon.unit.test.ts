import * as assert from "assert";
import { changeTypeIcon } from "../../branch-compare/changeTypeIcon";
import type { ChangeStatus } from "../../branch-compare/branchCompareData";

suite("changeTypeIcon", () => {
  test("every change kind maps to a diff codicon and a git decoration color", () => {
    const statuses: ChangeStatus[] = ["A", "M", "D", "R", "T", "U"];
    for (const status of statuses) {
      const { icon, color } = changeTypeIcon(status);
      assert.match(icon, /^diff-/, status);
      assert.match(color, /^gitDecoration\./, status);
    }
  });

  test("untracked shares the added shape but not its color", () => {
    assert.strictEqual(changeTypeIcon("U").icon, changeTypeIcon("A").icon);
    assert.notStrictEqual(changeTypeIcon("U").color, changeTypeIcon("A").color);
  });
});
