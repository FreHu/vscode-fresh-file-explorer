import {
  focusQuickInputRow, openTimeWindowPicker, parkMouse, pickQuickInput, setSidebarWidth, showOnlyFreshFiles, waitForFreshFile,
} from "../vscodeActions.mjs";

// DEMO_FADE_MS=200 crossfades between frames, for comparing against hard cuts.
const FADE_MS = Number(process.env.DEMO_FADE_MS ?? 0);

/** README hero: the tree grows as the time window widens → docs/img/time-window-switch.gif */
export default {
  output: FADE_MS ? `time-window-switch-fade${FADE_MS}.gif` : "time-window-switch.gif",
  window: { width: 780, height: 760 },
  settings: {
    "freshFileExplorer.autoExpandDepth": 5,
    "workbench.activityBar.location": "hidden",
  },
  async capture(page) {
    await setSidebarWidth(page, 470);
    await showOnlyFreshFiles(page, "giftCards.ts");
    await openTimeWindowPicker(page);
    await pickQuickInput(page, "Pending changes");
    await page.waitForTimeout(800);

    const frames = [];
    const shot = async holdMs => {
      await page.waitForTimeout(300); // tree rows and decorations settle
      // Right edge just past the picker: the empty editor beyond it carries nothing.
      frames.push({ png: await page.screenshot({ clip: { x: 0, y: 0, width: 640, height: 760 } }), holdMs, fadeMs: FADE_MS });
    };

    await parkMouse(page);
    await shot(2000);

    for (const [label, newFile] of [["1 week", "discounts.ts"], ["3 months", "architecture.md"]]) {
      await openTimeWindowPicker(page);
      await parkMouse(page); // the click leaves the pointer over a picker row, hover-highlighting it
      // The picker previews the focused window, so the tree behind it updates before the pick.
      await focusQuickInputRow(page, label); // the strong highlight, so the frame reads as "picking this one"
      await shot(1200);
      await pickQuickInput(page, label);
      await waitForFreshFile(page, newFile);
      await page.keyboard.press("Control+1"); // focus leaves the view: no outline on its header
      await parkMouse(page);
      await shot(label === "3 months" ? 3000 : 2000);
    }
    return frames;
  },
};
