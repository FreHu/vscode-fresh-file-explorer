import * as assert from "assert";
import { getGitLogLPanelHtml } from "../../logL/gitLogLPanelUI";
import { formatGitCommand } from "../../utils/formatUtils";

/**
 * Validates that the HTML emitted by webview panel UI functions is well-formed:
 * - Contains required structural elements
 * - References the external script bundle (no inline JS)
 */
suite("Webview HTML – gitLogLPanelUI", () => {
  const scriptUri = "vscode-webview://fake-origin/media/gitLogLPanel.js";
  const html = getGitLogLPanelHtml("https://example.com", scriptUri);

  test("contains DOCTYPE and html root", () => {
    assert.ok(html.startsWith("<!DOCTYPE html>"), "should start with DOCTYPE");
    assert.ok(html.includes("<html"), "should contain <html>");
    assert.ok(html.includes("</html>"), "should contain </html>");
  });

  test("contains required DOM element ids", () => {
    const requiredIds = [
      "title", "subtitle", "gitCommand", "timeline",
      "compareBtn", "clearBtn", "selectionInfo",
      "prevBtn", "nextBtn", "expandAllBtn", "collapseAllBtn",
    ];
    for (const id of requiredIds) {
      assert.ok(html.includes(`id="${id}"`), `missing element id="${id}"`);
    }
  });

  test("references external script with correct src", () => {
    assert.ok(
      html.includes(`src="${scriptUri}"`),
      "should reference the external script bundle via src attribute",
    );
    // No inline script body — the <script> tag should be self-contained
    const scriptMatch = html.match(/<script[^>]*src="[^"]*"[^>]*>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, "external <script src=...> tag not found");
    assert.strictEqual(scriptMatch![1].trim(), "", "script tag with src should have no inline body");
  });

  test("HTML is not truncated (ends with </html>)", () => {
    assert.ok(html.trimEnd().endsWith("</html>"), "HTML appears truncated");
  });
});

suite("formatGitCommand", () => {
  test("simple args need no quoting", () => {
    assert.strictEqual(
      formatGitCommand(["log", "--follow", "-p"]),
      "git log --follow -p",
    );
  });

  test("args with spaces are single-quoted", () => {
    assert.strictEqual(
      formatGitCommand(["log", "-L", "10,20:src/my file.ts"]),
      "git log -L '10,20:src/my file.ts'",
    );
  });

  test("funcname -L arg with colon is quoted", () => {
    assert.strictEqual(
      formatGitCommand(["log", "-L", ":myFunction:src/foo.ts"]),
      "git log -L ':myFunction:src/foo.ts'",
    );
  });

  test("line-range -L arg with colon is quoted", () => {
    assert.strictEqual(
      formatGitCommand(["log", "-L", "1,42:src/foo.ts"]),
      "git log -L '1,42:src/foo.ts'",
    );
  });

  test("file history args", () => {
    assert.strictEqual(
      formatGitCommand(["log", "--follow", "-p", "--", "src/foo.ts"]),
      "git log --follow -p -- src/foo.ts",
    );
  });
});
