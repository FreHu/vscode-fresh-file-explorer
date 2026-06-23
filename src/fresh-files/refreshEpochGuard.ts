/**
 * Cancellation primitive for the fresh-files refresh hierarchy.
 *
 * The tree load is a long, multi-phase async pipeline (discover repos → load
 * pending → load historical, with incremental threshold callbacks). When a
 * newer refresh starts mid-flight, the in-flight one must abandon its work so a
 * stale load never mutates state or over-exposes data.
 *
 * The mechanism is a single monotonically-incrementing epoch counter. An
 * in-flight operation {@link RefreshEpochGuard.capture | captures} a token at
 * the start; any later {@link RefreshEpochGuard.bump | bump} invalidates that
 * token. Two consumption styles share the same counter:
 *   - hard async boundaries call {@link RefreshToken.assertLive} (throws
 *     {@link RefreshCancelledError}, unwinding the load),
 *   - fire-and-forget incremental callbacks call {@link RefreshToken.isLive}
 *     and silently drop their update when stale.
 *
 * Kept in its own module so the contract is unit-testable in isolation — see
 * `refreshEpochGuard.unit.test.ts`.
 */

/** Thrown when a newer refresh has started and the current load should be abandoned. */
export class RefreshCancelledError extends Error {
  constructor() {
    super("refresh cancelled");
    this.name = "RefreshCancelledError";
  }
}

/** A snapshot of the guard's epoch at the moment an operation began. */
export class RefreshToken {
  constructor(
    private readonly _guard: RefreshEpochGuard,
    private readonly _captured: number,
  ) {}

  /** True while no newer refresh has bumped the guard since this token was captured. */
  isLive(): boolean {
    return this._guard.epoch === this._captured;
  }

  /** Throw {@link RefreshCancelledError} if a newer refresh has started. */
  assertLive(): void {
    if (!this.isLive()) {
      throw new RefreshCancelledError();
    }
  }
}

export class RefreshEpochGuard {
  private _epoch = 0;

  /** The current epoch. Bumped tokens captured before the latest bump are stale. */
  get epoch(): number {
    return this._epoch;
  }

  /** Invalidate every outstanding token. Call when a newer refresh starts. */
  bump(): void {
    this._epoch++;
  }

  /** Snapshot the current epoch for an operation about to start. */
  capture(): RefreshToken {
    return new RefreshToken(this, this._epoch);
  }
}
