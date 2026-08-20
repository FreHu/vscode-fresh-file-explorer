import * as assert from "assert";
import { html, raw, css } from "../../utils/templateHelpers";

// The webview panels render git-derived strings — commit subjects, author
// names, branch and file names — and a repository is untrusted input: users
// open clones and PR checkouts they did not write. The CSP blocks remote and
// inline <script>, but it does NOT stop markup injected through innerHTML, and
// `html` is the only thing standing between a commit subject and the DOM.
// It had no tests, so deleting an escape would have shipped green.

suite("html tagged template", () => {
  test("passes through static markup untouched", () => {
    assert.strictEqual(html`<p>hi</p>`, "<p>hi</p>");
  });

  test("escapes every HTML-significant character in an interpolated value", () => {
    assert.strictEqual(html`${"&"}`, "&amp;");
    assert.strictEqual(html`${"<"}`, "&lt;");
    assert.strictEqual(html`${">"}`, "&gt;");
    assert.strictEqual(html`${'"'}`, "&quot;");
    assert.strictEqual(html`${"'"}`, "&#039;");
  });

  test("neutralises a script tag in a commit subject", () => {
    const subject = "<script>alert(1)</script>";
    const out = html`<div>${subject}</div>`;
    assert.ok(!out.includes("<script"), `raw script tag survived: ${out}`);
    assert.strictEqual(out, "<div>&lt;script&gt;alert(1)&lt;/script&gt;</div>");
  });

  // The realistic payload: an attribute-breaking image with an error handler.
  // A nonce-based CSP does not stop this, because it is not a <script>.
  test("neutralises an onerror image payload", () => {
    const authorName = '<img src=x onerror="alert(1)">';
    const out = html`<span title="${authorName}">x</span>`;
    assert.ok(!out.includes("<img"), `raw img tag survived: ${out}`);
    assert.ok(!out.includes('onerror="alert(1)"'), `live handler survived: ${out}`);
  });

  test("escapes quotes so a value cannot break out of an attribute", () => {
    const branch = '" onmouseover="alert(1)';
    const out = html`<div data-branch="${branch}"></div>`;
    assert.strictEqual(out, '<div data-branch="&quot; onmouseover=&quot;alert(1)"></div>');
  });

  test("escapes ampersands first so escapes are not double-decoded", () => {
    assert.strictEqual(html`${"&lt;script&gt;"}`, "&amp;lt;script&amp;gt;");
  });

  test("escapes every interpolation, not just the first", () => {
    assert.strictEqual(html`${"<a>"}|${"<b>"}|${"<c>"}`, "&lt;a&gt;|&lt;b&gt;|&lt;c&gt;");
  });

  test("coerces non-strings before escaping", () => {
    assert.strictEqual(html`${42}`, "42");
    assert.strictEqual(html`${null}`, "null");
    assert.strictEqual(html`${undefined}`, "undefined");
  });

  test("raw() opts a value out of escaping", () => {
    assert.strictEqual(html`${raw("<b>bold</b>")}`, "<b>bold</b>");
  });

  test("raw() on one value does not disable escaping for the others", () => {
    const out = html`${raw("<b>ok</b>")}${"<script>"}`;
    assert.strictEqual(out, "<b>ok</b>&lt;script&gt;");
  });

  // A plain object must not be mistaken for a raw() marker: raw() brands its
  // payload with a module-private symbol precisely so untrusted data (say a
  // parsed JSON blob) cannot forge the opt-out.
  test("a plain object cannot forge the raw() marker", () => {
    const forged = { raw: "<script>alert(1)</script>" } as unknown as string;
    const out = html`${forged}`;
    assert.ok(!out.includes("<script"), `forged raw marker bypassed escaping: ${out}`);
  });
});

suite("css tagged template", () => {
  test("interpolates without escaping, as style content needs no HTML escaping", () => {
    assert.strictEqual(css`color: ${"red"};`, "color: red;");
  });
});
