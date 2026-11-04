import { paneClip, parkMouse, setPaneExpanded, setSidebarWidth } from "../vscodeActions.mjs";
import { addComparisons, BRANCH_COMPARE_SETTINGS, openComparisonsPanel } from "./branchCompareSettings.mjs";

/** The Branch Compare tree: one section per comparison → docs/img/branch-comparison-view.png */
export default {
  output: "branch-comparison-view.png",
  settings: {
    ...BRANCH_COMPARE_SETTINGS,
    "workbench.panel.opensMaximized": "never",
  },
  async capture(page) {
    await setSidebarWidth(page, 440);
    for (const title of ["orbit-shop", "Outline", "Timeline", "Fresh Files", "Pinned Items"]) {
      await setPaneExpanded(page, title, false);
    }
    await setPaneExpanded(page, "Fresh Files - Branch Compare", true);
    const frame = await openComparisonsPanel(page);
    await addComparisons(page, frame, ["v1.0.0", "HEAD~3"]);
    const compare = page.locator(".pane", { has: page.locator(".pane-header .title", { hasText: /^Fresh Files - Branch Compare$/i }) });
    await compare.locator(".monaco-list-row", { hasText: "payment.ts" }).first().waitFor();
    // Collapse the second section so both sections fit.
    const second = compare.locator(".monaco-list-row", { hasText: "last 3 commits" }).first();
    if ((await second.getAttribute("aria-expanded")) === "true") { await second.locator(".monaco-tl-twistie").click(); } // the arrow: collapses without selecting
    await page.keyboard.press("Control+1"); // focus leaves the tree: no focus outline on the row
    await parkMouse(page);
    await page.waitForTimeout(600);
    return page.screenshot({ clip: await paneClip(page, "Fresh Files - Branch Compare") });
  },
};
