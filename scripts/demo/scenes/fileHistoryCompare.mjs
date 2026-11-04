import { parkMouse } from "../vscodeActions.mjs";
import { HISTORY_SETTINGS, openFileHistory, panelClip } from "./fileHistory.mjs";

/** File History with two commits marked A and B for comparison → docs/img/file-history.png */
export default {
  output: "file-history.png",
  settings: HISTORY_SETTINGS,
  async capture(page) {
    const frame = await openFileHistory(page);
    const rows = frame.locator(".commit-row");
    await rows.nth(0).locator('[data-action="ab"]').click();
    await rows.nth(2).locator('[data-action="ab"]').click();
    await frame.locator(".ab-btn.sel-b").waitFor();
    await parkMouse(page);
    await page.waitForTimeout(400);
    return page.screenshot({ clip: await panelClip(page, rows.last()) });
  },
};
