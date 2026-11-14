import * as assert from "assert";
import { renderMessageSlice, splitCommitMessage, tokenizeCommitMessage } from "../../webview/commitMessageMarkup";

function kinds(text: string): [string, string][] {
  return tokenizeCommitMessage(text).map(t => [t.kind, text.slice(t.start, t.end)]);
}

suite("tokenizeCommitMessage", () => {
  test("trailer keys, with or without a colon for closing keywords", () => {
    const text = "Subject\n\nFixes #42\nCo-Authored-By: bo <bo@example.com>\nSigned-off-by: ada <a@x.io>";
    assert.deepStrictEqual(kinds(text), [
      ["trailer", "Fixes"],
      ["issue", "#42"],
      ["trailer", "Co-Authored-By"],
      ["email", "<bo@example.com>"],
      ["trailer", "Signed-off-by"],
      ["email", "<a@x.io>"],
    ]);
  });

  test("a hyphenated word mid-line is not a trailer", () => {
    assert.deepStrictEqual(kinds("uses a well-known: value"), []);
  });

  test("an issue ref or hash inside a link or inline code stays part of it", () => {
    assert.deepStrictEqual(kinds("see https://x.io/a#12 and `abc1234f`."), [
      ["link", "https://x.io/a#12"],
      ["code", "`abc1234f`"],
    ]);
  });

  test("hashes need a digit and a letter; owner/repo issue refs", () => {
    assert.deepStrictEqual(kinds("reverts 3fb5709 not deadbeefcafe nor 1234567; FreHu/repo#7"), [
      ["hash", "3fb5709"],
      ["issue", "FreHu/repo#7"],
    ]);
  });

  test("a link drops trailing punctuation", () => {
    assert.deepStrictEqual(kinds("(see https://example.com/pricing)."), [["link", "https://example.com/pricing"]]);
  });
});

suite("splitCommitMessage", () => {
  test("subject only", () => {
    assert.deepStrictEqual(splitCommitMessage("Fix it"), { subject: "Fix it", bodyStart: -1 });
  });

  test("body starts after the blank lines", () => {
    const msg = "Fix it\n\n\nBecause.";
    assert.deepStrictEqual(splitCommitMessage(msg), { subject: "Fix it", bodyStart: msg.indexOf("Because") });
  });
});

suite("renderMessageSlice", () => {
  test("escapes HTML and wraps tokens", () => {
    assert.strictEqual(renderMessageSlice("a <b> `x`", 0, 9), "a &lt;b&gt; <span class=\"cm-code\">`x`</span>");
  });

  test("a search hit inside a token is marked inside the token's span", () => {
    const msg = "Fixes #42";
    assert.strictEqual(
      renderMessageSlice(msg, 0, msg.length, [[7, 9]]),
      "<span class=\"cm-trailer\">Fixes</span> <span class=\"cm-issue\">#</span><span class=\"cm-issue\"><mark class=\"hl\">42</mark></span>",
    );
  });

  test("ranges and tokens are clipped to the slice", () => {
    const msg = "Subject\n\nFixes #42";
    assert.strictEqual(renderMessageSlice(msg, 0, 7, [[3, 12]]), "Sub<mark class=\"hl\">ject</mark>");
  });

  test("links become anchors", () => {
    assert.strictEqual(
      renderMessageSlice("go https://x.io", 0, 15),
      "go <a class=\"cm-link\" href=\"https://x.io\">https://x.io</a>",
    );
  });
});
