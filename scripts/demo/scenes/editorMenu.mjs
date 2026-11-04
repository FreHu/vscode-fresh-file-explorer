import { annotate } from "../annotate.mjs";
import { openFile, runCommand } from "../vscodeActions.mjs";

const OURS = ["Line/Function History", "File History", "Search Diffs for Selection", "Diff with baseline…", "Find Files Modified Together"];

/** The editor's right-click menu with the extension's entries outlined → docs/img/history-options.png */
export default {
  output: "history-options.png",
  window: { width: 1000, height: 760 },
  settings: {
    "workbench.activityBar.location": "hidden",
    "editor.minimap.enabled": false,
    "typescript.validate.enable": false,
    "editor.lightbulb.enabled": "off",
  },
  async capture(page) {
    await runCommand(page, "View: Close Primary Side Bar");
    await openFile(page, "payment.ts");
    const line = page.locator(".view-lines .view-line").nth(12);
    await line.click({ button: "right", position: { x: 120, y: 8 } });
    const menu = page.locator(".monaco-menu").first();
    await menu.waitFor();
    const entry = label => menu.locator(".action-item", { has: page.getByText(label, { exact: true }) });
    const present = [];
    for (const label of OURS) { if (await entry(label).count()) { present.push(entry(label)); } }
    if (present.length === 0) { throw new Error("none of the extension's entries are in the menu"); }
    await page.mouse.move(980, 740); // away from the menu: no hover highlight
    await page.waitForTimeout(300);
    await annotate(page, [{ target: { locators: [present[0], present[present.length - 1]] }, box: true, text: "Fresh File Explorer" }]);
    const box = await menu.boundingBox();
    return page.screenshot({ clip: { x: box.x - 12, y: box.y - 12, width: box.width + 210, height: box.height + 24 } });
  },
};
