import { annotate, clearAnnotations } from "../annotate.mjs";
import { parkMouse, selectTimeWindow, setSidebarWidth, showOnlyFreshFiles, waitForFreshFile } from "../vscodeActions.mjs";

/** A deleted file: still in the tree, viewable, restored in one click → docs/img/resurrect-demo.gif */
export default {
  output: "resurrect-demo.gif",
  window: { width: 1100, height: 640 },
  settings: {
    "freshFileExplorer.autoExpandDepth": 5,
    "workbench.activityBar.location": "hidden",
    "editor.minimap.enabled": false,
    "typescript.validate.enable": false,
    "workbench.editor.enablePreview": false,
    "editor.lightbulb.enabled": "off",
  },
  async capture(page) {
    await setSidebarWidth(page, 480);
    await showOnlyFreshFiles(page, "discounts.ts");
    await selectTimeWindow(page, "1 week");
    await waitForFreshFile(page, "legacyCheckout.ts");
    const row = () => page.locator('[id="workbench.view.explorer"] .monaco-list-row', { hasText: "legacyCheckout.ts" }).first();
    const rowText = () => row().locator(".label-name, .label-description").last();

    const frames = [];
    const shot = async (holdMs, notes) => {
      await page.waitForTimeout(400);
      await annotate(page, notes);
      frames.push({ png: await page.screenshot(), holdMs });
      await clearAnnotations(page);
    };
    const labelX = 640;

    // 1. Deleted, but still in the tree.
    await page.keyboard.press("Control+1");
    await parkMouse(page);
    await shot(2500, [{ target: { locator: rowText() }, text: "deleted 3 days ago, still in the tree", labelX }]);

    // 2. Click: its last content opens.
    await row().click();
    const tab = page.locator(".tab.active", { hasText: "legacyCheckout.ts" });
    await tab.waitFor();
    await parkMouse(page);
    const content = page.locator(".editor-instance .view-lines .view-line").first();
    await shot(2500, [{ target: { locator: content.locator("span span").last() }, text: "click: see what it contained", labelX: 870 }]);

    // 3. Right-click → Resurrect.
    await row().click({ button: "right" });
    const menu = page.locator(".monaco-menu").first();
    const resurrect = menu.locator(".action-item", { has: page.getByText("Resurrect Deleted File", { exact: true }) });
    await resurrect.waitFor();
    await resurrect.hover(); // the highlight shows which entry the next frame "clicks"
    await shot(2000, [{ target: { locator: menu }, text: "one click to bring it back", labelX: menuRight(await menu.boundingBox()) + 24 }]);

    // 4. Back where it was.
    await resurrect.click();
    await page.locator('[id="workbench.view.explorer"] .monaco-list-row', { hasText: "legacyCheckout.ts" })
      .locator(".label-description", { hasText: /^(?!D •)/ }).first().waitFor({ timeout: 20000 });
    await page.keyboard.press("Control+1");
    await parkMouse(page);
    await page.waitForTimeout(2000); // git's U decoration arrives after the tree row
    await shot(3000, [{ target: { locator: rowText() }, text: "restored to src/checkout, as a pending change", labelX }]);
    return frames;
  },
};

function menuRight(box) {
  return box.x + box.width;
}
