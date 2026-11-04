import { pane, parkMouse, setSidebarWidth, showOnlyFreshFiles } from "../vscodeActions.mjs";

/** The Fresh Files tree of the fixture repo, fully loaded. */
export default {
  output: "fresh-files-tree.png",
  settings: {
    "freshFileExplorer.autoExpandDepth": 5,
  },
  async capture(page) {
    await setSidebarWidth(page, 520);
    await showOnlyFreshFiles(page, "discounts.ts");
    await parkMouse(page);
    await page.waitForTimeout(500); // let the last decorations paint
    // Crop to the rendered rows: the pane itself stretches to fill the sidebar.
    const freshFiles = pane(page, "Fresh Files");
    const header = await freshFiles.locator(".pane-header").boundingBox();
    const rows = await freshFiles.locator(".monaco-list-row").evaluateAll(els => els.map(e => e.getBoundingClientRect().bottom));
    const bottom = Math.max(...rows) + 6;
    return page.screenshot({ clip: { x: header.x, y: header.y, width: header.width, height: bottom - header.y } });
  },
};
