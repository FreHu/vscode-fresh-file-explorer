import * as assert from "assert";
import { BoundedMap } from "../../utils/collectionUtils";

suite("BoundedMap", () => {
  test("stores and retrieves under capacity", () => {
    const m = new BoundedMap<string, number>(3);
    m.set("a", 1);
    m.set("b", 2);
    assert.strictEqual(m.get("a"), 1);
    assert.strictEqual(m.get("b"), 2);
    assert.strictEqual(m.size, 2);
  });

  test("never exceeds capacity", () => {
    const m = new BoundedMap<string, number>(3);
    for (let i = 0; i < 100; i++) {
      m.set(`k${i}`, i);
    }
    assert.strictEqual(m.size, 3);
  });

  test("evicts the least recently used entry first", () => {
    const m = new BoundedMap<string, number>(2);
    m.set("a", 1);
    m.set("b", 2);
    m.set("c", 3); // evicts "a"
    assert.strictEqual(m.has("a"), false);
    assert.strictEqual(m.get("b"), 2);
    assert.strictEqual(m.get("c"), 3);
  });

  test("a read refreshes recency, so a hot key survives", () => {
    const m = new BoundedMap<string, number>(2);
    m.set("a", 1);
    m.set("b", 2);
    assert.strictEqual(m.get("a"), 1); // "a" is now the newest
    m.set("c", 3); // should evict "b", not "a"
    assert.strictEqual(m.get("a"), 1, "recently read key must survive");
    assert.strictEqual(m.has("b"), false);
  });

  test("overwriting a key refreshes it without growing", () => {
    const m = new BoundedMap<string, number>(2);
    m.set("a", 1);
    m.set("b", 2);
    m.set("a", 10);
    assert.strictEqual(m.size, 2);
    assert.strictEqual(m.get("a"), 10);
    m.set("c", 3); // evicts "b", the true oldest
    assert.strictEqual(m.has("b"), false);
    assert.strictEqual(m.get("a"), 10);
  });

  test("missing keys read as undefined", () => {
    const m = new BoundedMap<string, number>(2);
    assert.strictEqual(m.get("nope"), undefined);
    assert.strictEqual(m.has("nope"), false);
  });

  test("delete removes an entry", () => {
    const m = new BoundedMap<string, number>(2);
    m.set("a", 1);
    assert.strictEqual(m.delete("a"), true);
    assert.strictEqual(m.has("a"), false);
    assert.strictEqual(m.delete("a"), false);
  });

  test("keysByAge reports least- to most-recently used", () => {
    const m = new BoundedMap<string, number>(3);
    m.set("a", 1);
    m.set("b", 2);
    m.set("c", 3);
    m.get("a");
    assert.deepStrictEqual(m.keysByAge(), ["b", "c", "a"]);
  });

  test("capacity of 1 keeps only the newest", () => {
    const m = new BoundedMap<string, number>(1);
    m.set("a", 1);
    m.set("b", 2);
    assert.strictEqual(m.size, 1);
    assert.strictEqual(m.get("b"), 2);
  });

  test("rejects a nonsensical capacity", () => {
    assert.throws(() => new BoundedMap<string, number>(0));
  });
});
