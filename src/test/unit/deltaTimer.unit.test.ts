import * as assert from "assert";
import { DeltaTracker, formatDelta } from "../../extension/deltaTimer";

// Pure, host-free, deterministic — we feed the clock in, so there's no Date.now
// and no flaky timing. Runs under plain mocha in milliseconds.

suite("DeltaTracker", () => {
  test("first tick reports 0", () => {
    const t = new DeltaTracker();
    assert.strictEqual(t.tick(1000), 0);
  });

  test("subsequent ticks report the gap to the previous tick", () => {
    const t = new DeltaTracker();
    assert.strictEqual(t.tick(1000), 0);
    assert.strictEqual(t.tick(1004), 4);
    assert.strictEqual(t.tick(1104), 100);
    assert.strictEqual(t.tick(1104), 0);
  });

  test("reset() makes the next tick a fresh start", () => {
    const t = new DeltaTracker();
    t.tick(1000);
    t.tick(2000);
    t.reset();
    assert.strictEqual(t.tick(5000), 0);
  });
});

suite("formatDelta", () => {
  test("renders +Nms", () => {
    assert.strictEqual(formatDelta(100).trim(), "+100ms");
    assert.strictEqual(formatDelta(0).trim(), "+0ms");
  });

  test("right-aligns to a fixed column width", () => {
    assert.strictEqual(formatDelta(100), "  +100ms");
    assert.strictEqual(formatDelta(0), "    +0ms");
    assert.strictEqual(formatDelta(100).length, formatDelta(0).length);
  });
});
