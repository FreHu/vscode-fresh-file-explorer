import * as assert from "assert";
import { commitsInWindow } from "../../stonks/stonksDataCollector";
import type { CommitStats } from "../../types";

function stat(hash: string, date: string): CommitStats {
  return { commit: { hash, date: new Date(date) }, added: 1, deleted: 0, modified: 0 } as unknown as CommitStats;
}

const NOW = new Date("2026-06-30T12:00:00");
const STATS = [stat("b", "2026-06-25T10:00:00"), stat("a", "2026-06-01T10:00:00"), stat("c", "2026-06-29T10:00:00")];

suite("commitsInWindow", () => {
  test("no window keeps every commit and finds the oldest", () => {
    const r = commitsInWindow(STATS, undefined, NOW);
    assert.deepStrictEqual(r?.stats.map(s => s.commit.hash), ["b", "a", "c"]);
    assert.strictEqual(r?.oldest.commit.hash, "a");
  });

  test("a window drops older commits; the oldest is taken from what remains", () => {
    const r = commitsInWindow(STATS, 7, NOW);
    assert.deepStrictEqual(r?.stats.map(s => s.commit.hash), ["b", "c"]);
    assert.strictEqual(r?.oldest.commit.hash, "b");
  });

  test("undefined when nothing falls in the window", () => {
    assert.strictEqual(commitsInWindow(STATS, 0, NOW), undefined);
    assert.strictEqual(commitsInWindow([], undefined, NOW), undefined);
  });
});
