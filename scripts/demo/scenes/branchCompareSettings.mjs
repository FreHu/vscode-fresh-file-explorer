import { parkMouse, runCommand } from "../vscodeActions.mjs";

export const BRANCH_COMPARE_SETTINGS = {
  "workbench.activityBar.location": "hidden",
  "workbench.panel.opensMaximized": "always",
};

/** Opens the Branch Compare panel; returns its webview frame. */
export async function openComparisonsPanel(page) {
  await runCommand(page, "Open Branch Compare Settings…");
  const frame = page.frameLocator("iframe.webview.ready").frameLocator("#active-frame");
  await frame.locator("#addBtn").waitFor();
  return frame;
}

/** Adds `HEAD..target` comparisons through the panel's own "+ Add comparison" flow. */
export async function addComparisons(page, frame, targets) {
  for (const target of targets) {
    await frame.locator("#addBtn").click();
    const input = frame.locator("tr.draft-row:last-child .ref-input[data-field='target']");
    await input.fill(target);
    await input.press("Enter");
    await page.keyboard.press("Escape"); // close the ref suggestions
    await frame.locator("tr:not(.draft-row) .ref-input[data-field='target']", { hasText: "" }).first().waitFor();
    await page.waitForTimeout(600);
  }
}

/** The Branch Compare panel with two comparisons, one driving the heatmap → docs/img/branch-comparison-settings.png */
export default {
  output: "branch-comparison-settings.png",
  window: { width: 1300, height: 700 },
  settings: BRANCH_COMPARE_SETTINGS,
  async capture(page) {
    await runCommand(page, "View: Close Primary Side Bar");
    const frame = await openComparisonsPanel(page);
    await addComparisons(page, frame, ["v1.0.0", "HEAD~3"]);
    await frame.locator(".col-heatmap button").first().click();
    await frame.locator(".col-heatmap button.heatmap-on").waitFor();
    await parkMouse(page);
    await page.waitForTimeout(600);
    const panel = await page.locator(".part.panel").boundingBox();
    return page.screenshot({ clip: panel });
  },
};
