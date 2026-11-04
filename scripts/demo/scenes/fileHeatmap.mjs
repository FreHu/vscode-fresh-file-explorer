import { paneClip, parkMouse, runCommand, selectTimeWindow, setSidebarWidth, showOnlyFreshFiles, waitForFreshFile } from "../vscodeActions.mjs";

/** Fresh Files coloured by recency over 3 months → docs/img/heatmap.png */
export default {
  output: "heatmap.png",
  settings: {
    "freshFileExplorer.autoExpandDepth": 5,
  },
  async capture(page) {
    await setSidebarWidth(page, 520);
    await showOnlyFreshFiles(page, "discounts.ts");
    await selectTimeWindow(page, "3 months");
    await waitForFreshFile(page, "architecture.md");
    await runCommand(page, "Toggle Heatmap Coloring");
    await parkMouse(page);
    await page.waitForTimeout(800); // decorations repaint
    return page.screenshot({ clip: await paneClip(page, "Fresh Files") });
  },
};
