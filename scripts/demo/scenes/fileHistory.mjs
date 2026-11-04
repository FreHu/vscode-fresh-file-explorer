import { openFile, parkMouse, runCommand } from "../vscodeActions.mjs";

export const HISTORY_SETTINGS = {
  "workbench.activityBar.location": "hidden",
  "editor.minimap.enabled": false,
  "typescript.validate.enable": false,
};

/** Opens the File History panel for the fixture's payment.ts; returns its webview frame. */
export async function openFileHistory(page) {
  await runCommand(page, "View: Close Primary Side Bar");
  await openFile(page, "payment.ts");
  await runCommand(page, "File History");
  const frame = page.frameLocator("iframe.webview.ready").frameLocator("#active-frame");
  await frame.locator(".commit-row").first().waitFor();
  return frame;
}

/** Page-coordinate clip from the panel's top down to just below `bottomOf`. */
export async function panelClip(page, bottomOf) {
  const editor = await page.locator(".part.editor").boundingBox();
  const bottom = await bottomOf.boundingBox();
  const height = Math.min(bottom.y + bottom.height + 12, editor.y + editor.height) - editor.y;
  return { x: editor.x, y: editor.y, width: editor.width, height };
}

/** File History with the newest commit's diff open → docs/img/history-view.png */
export default {
  output: "history-view.png",
  settings: HISTORY_SETTINGS,
  async capture(page) {
    const frame = await openFileHistory(page);
    const rows = frame.locator(".commit-row");
    await rows.first().locator(".commit-header").click();
    await rows.first().locator(".hunk").first().waitFor();
    await parkMouse(page);
    await page.waitForTimeout(400);
    return page.screenshot({ clip: await panelClip(page, rows.last()) });
  },
};
