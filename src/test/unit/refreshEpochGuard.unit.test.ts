import * as assert from "assert";
import {
  RefreshEpochGuard,
  RefreshCancelledError,
  RefreshToken,
} from "../../fresh-files/refreshEpochGuard";

// Pure, host-free, deterministic. Locks the refresh-cancellation contract that
// freshFileProvider's load pipeline depends on: a token captured before a bump
// must report stale afterwards, on both the throwing and the silent path.

suite("RefreshEpochGuard", () => {
  test("a fresh token is live and assertLive does not throw", () => {
    const guard = new RefreshEpochGuard();
    const token = guard.capture();
    assert.strictEqual(token.isLive(), true);
    assert.doesNotThrow(() => token.assertLive());
  });

  test("bump() invalidates a previously-captured token", () => {
    const guard = new RefreshEpochGuard();
    const token = guard.capture();
    guard.bump();
    assert.strictEqual(token.isLive(), false);
  });

  test("assertLive throws RefreshCancelledError after a bump", () => {
    const guard = new RefreshEpochGuard();
    const token = guard.capture();
    guard.bump();
    assert.throws(() => token.assertLive(), RefreshCancelledError);
  });

  test("a token captured after the bump is live again", () => {
    const guard = new RefreshEpochGuard();
    const stale = guard.capture();
    guard.bump();
    const fresh = guard.capture();
    assert.strictEqual(stale.isLive(), false);
    assert.strictEqual(fresh.isLive(), true);
    assert.doesNotThrow(() => fresh.assertLive());
  });

  test("multiple bumps keep an old token stale (no wraparound to live)", () => {
    const guard = new RefreshEpochGuard();
    const token = guard.capture();
    guard.bump();
    guard.bump();
    guard.bump();
    assert.strictEqual(token.isLive(), false);
    assert.throws(() => token.assertLive(), RefreshCancelledError);
  });

  test("captures with no intervening bump are all live", () => {
    const guard = new RefreshEpochGuard();
    const a = guard.capture();
    const b = guard.capture();
    assert.strictEqual(a.isLive(), true);
    assert.strictEqual(b.isLive(), true);
  });

  test("the error carries a recognizable name and message", () => {
    const err = new RefreshCancelledError();
    assert.strictEqual(err.name, "RefreshCancelledError");
    assert.ok(err instanceof Error);
    assert.match(err.message, /cancel/i);
  });

  // Mirrors updateFreshFiles: a bump that lands between two async boundaries
  // must cancel the load at the very next assert, not before and not never.
  test("assertLive at each async boundary cancels exactly when a bump lands mid-load", async () => {
    const guard = new RefreshEpochGuard();
    const token = guard.capture();
    const assertNotCancelled = () => token.assertLive();

    // Boundary 1: nothing has bumped yet — load proceeds.
    await Promise.resolve();
    assert.doesNotThrow(assertNotCancelled, "should survive the first boundary");

    // A newer refresh starts while phase 2 is in flight.
    guard.bump();

    // Boundary 2: the next assert must abort the stale load.
    await Promise.resolve();
    assert.throws(assertNotCancelled, RefreshCancelledError, "should cancel at the boundary after the bump");
  });

  // Mirrors the incremental threshold callback: stale partial updates are
  // dropped silently (isLive === false) rather than throwing.
  test("isLive lets stale incremental callbacks no-op without throwing", () => {
    const guard = new RefreshEpochGuard();
    const token = guard.capture();
    const applied: number[] = [];
    const onThresholdCrossed = (days: number) => {
      if (!token.isLive()) { return; }
      applied.push(days);
    };

    onThresholdCrossed(7);   // live → applied
    guard.bump();
    onThresholdCrossed(30);  // stale → dropped

    assert.deepStrictEqual(applied, [7]);
  });

  test("capture() returns a RefreshToken instance", () => {
    const guard = new RefreshEpochGuard();
    assert.ok(guard.capture() instanceof RefreshToken);
  });
});
