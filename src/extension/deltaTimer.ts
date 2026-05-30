// The one part of the logger worth owning: the elapsed delta between log lines.
//
// Pure and `vscode`-free, and never calls Date.now() itself — the caller passes
// the current time in. That makes the delta math fully deterministic and
// unit-testable in plain Node, with no Extension Host and no flaky timing. The
// channel that displays these lines is just a vehicle (see logger.ts).

/** Tracks the timestamp of the previous tick and reports the gap to the next. */
export class DeltaTracker {
  private last: number | undefined;

  /** Record `now` and return ms since the previous tick. The first tick has
   *  no predecessor, so it reports 0 (renders as "+0ms"). */
  tick(now: number): number {
    if (this.last === undefined) {
      this.last = now;
      return 0;
    }
    const delta = now - this.last;
    this.last = now;
    return delta;
  }

  reset(): void {
    this.last = undefined;
  }
}

/** Render a delta as a right-aligned `+Nms` tag, e.g. `"  +100ms"`. The padding
 *  keeps the deltas in a column so the eye can scan for the big jumps. */
export function formatDelta(deltaMs: number, width = 8): string {
  return `+${deltaMs}ms`.padStart(width);
}
