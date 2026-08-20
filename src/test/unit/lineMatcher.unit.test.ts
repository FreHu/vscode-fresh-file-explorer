import * as assert from "assert";
import { createLineMatcher } from "../../diff-search/lineMatcher";

suite("createLineMatcher", () => {
  test("exact substring by default", () => {
    const m = createLineMatcher("foo", null, false);
    assert.strictEqual(m("a foo b"), true);
    assert.strictEqual(m("a bar b"), false);
  });

  test("substring matching is case-sensitive unless asked otherwise", () => {
    const m = createLineMatcher("Foo", null, false);
    assert.strictEqual(m("Foo"), true);
    assert.strictEqual(m("foo"), false);
  });

  test("case-insensitive substring matches either casing", () => {
    const m = createLineMatcher("Foo", null, true);
    assert.strictEqual(m("foo"), true);
    assert.strictEqual(m("FOO"), true);
    assert.strictEqual(m("bar"), false);
  });

  test("a regex wins over the substring branches", () => {
    const m = createLineMatcher("ignored", /^a.c$/, false);
    assert.strictEqual(m("abc"), true);
    assert.strictEqual(m("ignored"), false, "the pattern string must not be consulted");
  });

  // Callers compile the regex with `i` themselves, so caseInsensitive must not
  // additionally alter regex behaviour.
  test("caseInsensitive does not change the regex branch", () => {
    const sensitive = createLineMatcher("x", /abc/, true);
    assert.strictEqual(sensitive("ABC"), false, "casing is the regex's own business");
    const insensitive = createLineMatcher("x", /abc/i, true);
    assert.strictEqual(insensitive("ABC"), true);
  });

  test("regex metacharacters are literal in substring mode", () => {
    const m = createLineMatcher("a.c", null, false);
    assert.strictEqual(m("a.c"), true);
    assert.strictEqual(m("abc"), false, "the dot must not act as a wildcard");
  });

  test("an empty pattern matches every line in substring mode", () => {
    assert.strictEqual(createLineMatcher("", null, false)("anything"), true);
    assert.strictEqual(createLineMatcher("", null, true)("anything"), true);
  });

  // The reason this is a factory: the pattern is lowercased once, not per line.
  test("the returned predicate is reusable across many lines", () => {
    const m = createLineMatcher("Needle", null, true);
    const lines = ["no", "NEEDLE here", "nope", "needle"];
    assert.deepStrictEqual(lines.filter(m), ["NEEDLE here", "needle"]);
  });

  test("a stateful global regex does not desync across calls", () => {
    const m = createLineMatcher("x", /foo/, false);
    assert.strictEqual(m("foo"), true);
    assert.strictEqual(m("foo"), true, "consecutive calls must agree");
  });
});
