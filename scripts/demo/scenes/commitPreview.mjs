import { annotate } from "../annotate.mjs";
import { pane, parkMouse, showOnlyFreshFiles } from "../vscodeActions.mjs";

/** Open Commit on a fresh file: the multi-diff editor with the full commit message on top → docs/img/commit-preview.png */
export default {
  output: "commit-preview.png",
  settings: {
    "freshFileExplorer.autoExpandDepth": 5,
    "workbench.activityBar.location": "hidden",
    "editor.minimap.enabled": false,
    "diffEditor.renderSideBySide": false,
  },
  async capture(page) {
    await showOnlyFreshFiles(page, "discounts.ts");
    await pane(page, "Fresh Files").locator(".monaco-list-row", { hasText: "discounts.ts" }).first().click({ button: "right" });
    await page.locator(".context-view .action-label", { hasText: /^Open Commit$/ }).first().click();
    await page.locator(".multiDiffEditor").waitFor();
    await parkMouse(page);
    await page.waitForTimeout(1500);
    await annotate(page, [{
      // The entry's folder label (`\<short hash>`), so the leader line doesn't cross it.
      target: { locator: page.locator(".multiDiffEditor").getByText(/^\\[0-9a-f]{7}$/).first() },
      text: "not part of the commit: a synthetic entry that shows its full message",
      labelX: 560,
    }]);
    const editor = await page.locator(".part.editor").boundingBox();
    return page.screenshot({ clip: { x: editor.x, y: editor.y, width: editor.width, height: Math.min(editor.height, 600) } });
  },
};
