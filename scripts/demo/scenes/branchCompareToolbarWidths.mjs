import { runCommand } from "../vscodeActions.mjs";

/**
 * Layout check, not a docs image: the Branch Comparisons settings toolbar at a wide,
 * medium and narrow panel, stacked into one PNG.
 */
export default {
  output: "check-branch-compare-toolbar.png",
  window: { width: 1100, height: 700 },
  settings: {
    "workbench.activityBar.location": "hidden",
    "workbench.panel.opensMaximized": "always",
  },
  async capture(page, { app }) {
    await runCommand(page, "View: Close Primary Side Bar");
    await runCommand(page, "Branch Compare: Open Comparisons Settings…");
    const frame = page.frameLocator("iframe.webview.ready").frameLocator("#active-frame");
    const toolbar = frame.locator(".table-toolbar");
    await toolbar.waitFor();
    const win = await app.browserWindow(page);

    const shots = [];
    for (const width of [900, 560, 380]) {
      await win.evaluate((w, size) => w.setContentSize(size, 700), width);
      await page.mouse.move(1, 1);
      await page.waitForTimeout(600);
      shots.push((await page.screenshot({ clip: await toolbarClip(toolbar) })).toString("base64"));
    }
    return stack(page, shots);
  },
};

async function toolbarClip(toolbar) {
  const box = await toolbar.boundingBox();
  return { x: box.x - 8, y: box.y - 6, width: box.width + 16, height: box.height + 12 };
}

/** Stacks PNGs vertically, left-aligned, using the page's canvas. */
async function stack(page, base64Pngs) {
  const out = await page.evaluate(async srcs => {
    const imgs = await Promise.all(srcs.map(async s => { const i = new Image(); i.src = `data:image/png;base64,${s}`; await i.decode(); return i; }));
    const gap = 12;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(...imgs.map(i => i.naturalWidth));
    canvas.height = imgs.reduce((h, i) => h + i.naturalHeight + gap, -gap);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ff00ff"; // visible gutter between the widths
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    let y = 0;
    for (const i of imgs) { ctx.drawImage(i, 0, y); y += i.naturalHeight + gap; }
    return canvas.toDataURL("image/png").split(",")[1];
  }, base64Pngs);
  return Buffer.from(out, "base64");
}
