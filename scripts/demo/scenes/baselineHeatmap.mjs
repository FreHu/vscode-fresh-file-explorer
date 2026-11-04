import { annotate } from "../annotate.mjs";
import { openFile, parkMouse, pickQuickInput, runCommand } from "../vscodeActions.mjs";

/** Blame heatmap in Baseline mode vs the fixture's v1.0.0 tag → docs/img/baseline-heatmap.png */
export default {
  output: "baseline-heatmap.png",
  settings: {
    "workbench.activityBar.location": "hidden",
    "editor.minimap.enabled": false,
    "typescript.validate.enable": false, // the fixture's imports don't resolve
    "editor.lightbulb.enabled": "off",
    "editor.renderLineHighlight": "none",
  },
  async capture(page) {
    await runCommand(page, "View: Close Primary Side Bar");
    await openFile(page, "payment.ts");
    await runCommand(page, "Blame Heatmap");
    await pickQuickInput(page, "Baseline");
    await pickQuickInput(page, "v1.0.0");
    const status = page.locator(".statusbar-item", { hasText: "Heatmap: vs v1.0.0" });
    await status.waitFor();
    await page.waitForTimeout(500); // decorations paint after the status bar updates
    await parkMouse(page);

    const labelX = 900;
    await annotate(page, [
      { target: { editorLine: 3 }, text: "added since v1.0.0", labelX },
      { target: { editorLine: 8 }, text: "unchanged since v1.0.0: no color", labelX },
      { target: { editorLines: [17, 18] }, text: "changed since v1.0.0, 12 days ago", labelX },
      { target: { editorLines: [21, 25] }, text: "changed 5 days ago: brighter", labelX },
      { target: { editorLine: 27 }, text: "uncommitted", labelX },
      { target: { editorGutter: 32 }, text: "4 lines deleted: right-click to restore or copy", labelX },
      { target: { locator: status }, text: "the baseline", labelX: 460 },
    ]);
    return page.screenshot({ clip: { x: 0, y: 36, width: 1280, height: 764 } });
  },
};
