import { openFile, parkMouse, runCommand } from "../vscodeActions.mjs";
import { HISTORY_SETTINGS, panelClip } from "./fileHistory.mjs";

/** Line/Function History of payment.ts's pay() → docs/img/l-history.png */
export default {
  output: "l-history.png",
  window: { width: 1100, height: 760 },
  settings: HISTORY_SETTINGS,
  async capture(page) {
    await runCommand(page, "View: Close Primary Side Bar");
    await openFile(page, "payment.ts");
    // A single cursor on a word asks for that function's history (git log -L :pay:file).
    await page.keyboard.press("Control+G");
    await page.keyboard.type("13:23");
    await page.keyboard.press("Enter");
    await runCommand(page, "Line/Function History");
    const frame = page.frameLocator("iframe.webview.ready").frameLocator("#active-frame");
    const rows = frame.locator(".commit-row");
    await rows.first().waitFor();
    await rows.first().locator(".commit-header").click();
    await rows.first().locator(".hunk").first().waitFor();
    await parkMouse(page);
    await page.waitForTimeout(400);
    return page.screenshot({ clip: await panelClip(page, rows.last()) });
  },
};
