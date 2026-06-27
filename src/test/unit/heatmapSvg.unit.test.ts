import * as assert from "assert";
import { gutterBarSvg, deletionBadgeSvg } from "../../heatmap/heatmapSvg";

suite("heatmapSvg", () => {
  suite("gutterBarSvg", () => {
    test("percent-encodes the '#' so the string is data-URI safe", () => {
      const svg = gutterBarSvg("#ff0000");
      assert.ok(!svg.includes("#"), "raw '#' must not survive — it breaks data: URIs");
      assert.ok(svg.includes("%23ff0000"));
    });

    test("produces a well-formed 16x16 svg", () => {
      const svg = gutterBarSvg("#abc");
      assert.ok(svg.startsWith("<svg"));
      assert.ok(svg.includes("width='16'") && svg.includes("height='16'"));
    });
  });

  suite("deletionBadgeSvg", () => {
    test("renders the count", () => {
      assert.ok(deletionBadgeSvg(36).includes(">36<"));
    });

    test("caps at 999+", () => {
      assert.ok(deletionBadgeSvg(1500).includes(">999+<"));
    });

    test("shrinks font as the digit count grows", () => {
      const fontOf = (s: string) => Number(/font-size='(\d+)'/.exec(s)![1]);
      assert.ok(fontOf(deletionBadgeSvg(1)) > fontOf(deletionBadgeSvg(12)));
      assert.ok(fontOf(deletionBadgeSvg(12)) > fontOf(deletionBadgeSvg(123)));
      assert.ok(fontOf(deletionBadgeSvg(123)) > fontOf(deletionBadgeSvg(1234)));
    });
  });
});
