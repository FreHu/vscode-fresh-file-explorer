import * as assert from "assert";
import { ConfigKeys } from "../../config/configKeyConstants";
import { resolveConfigRefreshAction } from "../../fresh-files/configRefreshAction";

/** Build an `affects` predicate that returns true for exactly the given config sections. */
function affecting(...changed: string[]): (section: string) => boolean {
  return (section) => changed.includes(section);
}

suite("resolveConfigRefreshAction", () => {
  test("no relevant change → none", () => {
    assert.strictEqual(resolveConfigRefreshAction(() => false), "none");
  });

  test("a display-only key → treeOnly", () => {
    assert.strictEqual(
      resolveConfigRefreshAction(affecting(ConfigKeys.DESCRIPTION_SHOW_DATE)),
      "treeOnly",
    );
  });

  test("line-changes key → pending", () => {
    assert.strictEqual(
      resolveConfigRefreshAction(affecting(ConfigKeys.DESCRIPTION_SHOW_LINE_CHANGES)),
      "pending",
    );
  });

  test("time-windows key → hard", () => {
    assert.strictEqual(
      resolveConfigRefreshAction(affecting(ConfigKeys.TIME_WINDOWS)),
      "hard",
    );
  });

  test("a behavioural-only key → none", () => {
    assert.strictEqual(
      resolveConfigRefreshAction(affecting(ConfigKeys.HEATMAP_ENABLED)),
      "none",
    );
  });

  suite("escalation — most expensive wins", () => {
    test("treeOnly + pending → pending", () => {
      assert.strictEqual(
        resolveConfigRefreshAction(affecting(
          ConfigKeys.DESCRIPTION_SHOW_DATE,
          ConfigKeys.DESCRIPTION_SHOW_LINE_CHANGES,
        )),
        "pending",
      );
    });

    test("pending + hard → hard", () => {
      assert.strictEqual(
        resolveConfigRefreshAction(affecting(
          ConfigKeys.DESCRIPTION_SHOW_LINE_CHANGES,
          ConfigKeys.TIME_WINDOWS,
        )),
        "hard",
      );
    });

    test("none + treeOnly → treeOnly (none never suppresses a real action)", () => {
      assert.strictEqual(
        resolveConfigRefreshAction(affecting(
          ConfigKeys.HEATMAP_ENABLED,
          ConfigKeys.DESCRIPTION_SHOW_DATE,
        )),
        "treeOnly",
      );
    });

    test("AI co-author emails escalate to hard (re-parses git log)", () => {
      assert.strictEqual(
        resolveConfigRefreshAction(affecting(
          ConfigKeys.AI_COAUTHOR_EMAILS,
          ConfigKeys.DESCRIPTION_SHOW_DATE,
        )),
        "hard",
      );
    });
  });
});
