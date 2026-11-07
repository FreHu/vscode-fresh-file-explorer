// Characterization snapshot for the CodeStonks webview: saves the chart's SVG
// and a hover tooltip for every x-axis mode, so a refactor can be checked by
// diffing two runs (scripts/demo/stonksSnapshotDiff.mjs). The fixture's commit
// dates are relative to noon today, so compare runs from the same day.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parkMouse, runCommand } from "../vscodeActions.mjs";

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.scratch/claude/demo/stonks-snapshot");
const MODES = ["commit", "day", "week", "month"];

export default {
  output: "stonks-snapshot.png",
  window: { width: 1400, height: 1100 },
  settings: { "workbench.activityBar.location": "hidden" },
  // Commit times are `now - daysAgo`, so the heatmap's hours follow the clock:
  // pin the fixture to noon today and runs from the same day compare equal.
  workspace: ({ stateDir, buildFixtureRepo }) =>
    buildFixtureRepo(join(stateDir, "orbit-shop"), new Date().setHours(12, 0, 0, 0)),
  async capture(page) {
    mkdirSync(outDir, { recursive: true });
    await runCommand(page, "View: Close Primary Side Bar");
    await runCommand(page, "CodeStonks");
    const frame = page.frameLocator("iframe.webview.ready").frameLocator("#active-frame");
    await frame.locator("#chart #hitArea").waitFor({ timeout: 30000 });

    // Every section on, so each renderer contributes to the snapshot. Most are opt-in.
    const toggles = ["FileCount", "FilesChanged", "Authors", "AuthorConcentration", "Velocity", "Churn", "CommitSize", "ActivityHeatmap"];
    for (const name of toggles) {
      const toggle = frame.locator(`#toggle${name}`);
      if (!(await toggle.isChecked())) { await toggle.check({ force: true }); }
    }

    let shot;
    for (const mode of MODES) {
      await frame.locator("#xAxisSelect").selectOption(mode);
      await frame.locator("#chart #hitArea").waitFor();
      await page.waitForTimeout(400);
      writeFileSync(join(outDir, `${mode}.svg`), await frame.locator("#chart").innerHTML());

      // Hover the middle of the plot: crosshair position and tooltip text.
      const hit = await frame.locator("#chart #hitArea").boundingBox();
      await page.mouse.move(hit.x + hit.width / 2, hit.y + hit.height / 3);
      await page.waitForTimeout(200);
      writeFileSync(join(outDir, `${mode}.tooltip.html`), await frame.locator("#tooltip").innerHTML());
      if (mode === "commit") { shot = await page.screenshot(); }
      await parkMouse(page);
    }
    return shot;
  },
};
