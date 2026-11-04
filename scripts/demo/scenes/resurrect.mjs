import { selectTimeWindow, setSidebarWidth, showOnlyFreshFiles, waitForFreshFile } from "../vscodeActions.mjs";

/** A deleted file in the tree with its right-click menu open → docs/img/resurrect.png */
export default {
  output: "resurrect.png",
  settings: {
    "freshFileExplorer.autoExpandDepth": 5,
  },
  async capture(page) {
    await setSidebarWidth(page, 520);
    await showOnlyFreshFiles(page, "discounts.ts");
    await selectTimeWindow(page, "1 week");
    await waitForFreshFile(page, "legacyCheckout.ts");
    const row = page.locator('[id="workbench.view.explorer"] .monaco-list-row', { hasText: "legacyCheckout.ts" }).first();
    await row.click({ button: "right" });
    const menu = page.locator(".monaco-menu").first();
    await menu.locator(".action-item", { has: page.getByText("Resurrect Deleted File", { exact: true }) }).waitFor();
    await page.mouse.move(5, 790);
    await page.waitForTimeout(300);
    const r = await row.boundingBox();
    const m = await menu.boundingBox();
    const top = Math.min(r.y, m.y) - 40;
    const bottom = Math.max(r.y + r.height, m.y + m.height) + 8;
    const left = r.x;
    const right = Math.max(r.x + r.width, m.x + m.width) + 8;
    return page.screenshot({ clip: { x: left, y: top, width: right - left, height: bottom - top } });
  },
};
