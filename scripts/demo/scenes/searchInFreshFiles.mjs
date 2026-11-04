import { annotate } from "../annotate.mjs";
import { parkMouse, runCommand, selectTimeWindow, setSidebarWidth, showOnlyFreshFiles, waitForFreshFile } from "../vscodeActions.mjs";

/** Search editor scoped to the fresh files of the last week → docs/img/ff-search.png */
export default {
  output: "ff-search.png",
  window: { width: 1400, height: 720 },
  settings: {
    "freshFileExplorer.autoExpandDepth": 5,
    "workbench.activityBar.location": "hidden",
  },
  async capture(page) {
    await setSidebarWidth(page, 470);
    await showOnlyFreshFiles(page, "discounts.ts");
    await selectTimeWindow(page, "1 week");
    await waitForFreshFile(page, "legacyCheckout.ts");
    await runCommand(page, "Search in Fresh Files");
    const query = page.locator(".search-editor .search-widget textarea, .search-editor .search-widget input").first();
    await query.waitFor();
    await query.fill("export");
    await page.keyboard.press("Enter");
    await page.locator(".search-editor .monaco-editor .view-line", { hasText: "results" }).first().waitFor();
    await parkMouse(page);
    await page.waitForTimeout(600);
    const include = page.locator(".search-editor .includes .monaco-inputbox").first();
    await annotate(page, [
      { target: { locator: include }, box: true },
      { target: { locator: include }, text: "the files in the tree, as the search scope", below: 22 },
    ]);
    return page.screenshot();
  },
};
