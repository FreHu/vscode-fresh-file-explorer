import * as assert from "assert";
import { ADDED_FILL, formatTooltipDate, renderBar, renderCommitTooltipHeader, renderDateXAxis, xAxisLabelIndices } from "../../webview/svgChartPrimitives";

const PAD = { top: 10, right: 10, bottom: 10, left: 40 };

suite("xAxisLabelIndices", () => {
  test("every step from the first point", () => {
    assert.deepStrictEqual(xAxisLabelIndices(9, 4), [0, 4, 8]);
  });

  test("adds the last point when it is more than half a step past the previous label", () => {
    assert.deepStrictEqual(xAxisLabelIndices(8, 4), [0, 4, 7]);
  });

  test("skips the last point when it would crowd the previous label", () => {
    assert.deepStrictEqual(xAxisLabelIndices(10, 4), [0, 4, 8]);
  });

  test("a single point gets one label", () => {
    assert.deepStrictEqual(xAxisLabelIndices(1, 1), [0]);
  });
});

suite("renderCommitTooltipHeader", () => {
  test("hash, message and author/date lines, escaped", () => {
    assert.strictEqual(
      renderCommitTooltipHeader("abc1234", "fix <b>", "Ann", "Mar 5, 2026"),
      `<div class="hash">abc1234</div><div class="message">fix &lt;b&gt;</div><div class="author">Ann · Mar 5, 2026</div>`,
    );
  });

  test("formatTooltipDate includes the year", () => {
    assert.ok(formatTooltipDate("2026-03-05T12:00:00Z").includes("2026"));
  });
});

suite("renderBar", () => {
  test("centred on its point, standing on the base line", () => {
    assert.strictEqual(
      renderBar(2, 10, PAD, 100, 30, ADDED_FILL),
      `<rect x="57" y="70" width="6" height="30" fill="${ADDED_FILL}" opacity="0.7"/>`,
    );
  });

  test("width stays between 1 and 12px", () => {
    assert.ok(renderBar(0, 1, PAD, 0, 1, "red").includes(`width="1"`));
    assert.ok(renderBar(0, 100, PAD, 0, 1, "red").includes(`width="12"`));
  });
});

suite("renderDateXAxis", () => {
  test("labels sit at labelY and the first/last are anchored at the edges", () => {
    const dates = ["2026-01-01T12:00:00Z", "2026-01-02T12:00:00Z", "2026-01-03T12:00:00Z"];
    const svg = renderDateXAxis(dates, 3, 10, 14, PAD, 1);
    const texts = svg.match(/<text [^>]*>/g) ?? [];
    assert.strictEqual(texts.length, 3);
    assert.ok(texts.every(t => t.includes(`y="14"`)));
    assert.ok(texts[0].includes(`x="40"`) && texts[0].includes(`text-anchor="start"`));
    assert.ok(texts[1].includes(`text-anchor="middle"`));
    assert.ok(texts[2].includes(`x="60"`) && texts[2].includes(`text-anchor="end"`));
  });
});
