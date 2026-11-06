import { join } from "node:path";
import { buildSubmoduleWorkspace } from "../fixtureRepo.mjs";
import { pane, parkMouse, selectTimeWindow, setPaneExpanded, setSidebarWidth } from "../vscodeActions.mjs";

/**
 * Submodules in the Fresh Files tree: an initialized one with its own changes, one nested
 * inside it, and one declared but not checked out → docs/img/submodules.png
 */
export default {
  output: "submodules.png",
  window: { width: 1100, height: 900 },
  settings: {
    "freshFileExplorer.autoExpandDepth": 5,
  },
  workspace: ({ stateDir }) => buildSubmoduleWorkspace(join(stateDir, "ws")).main,
  async capture(page) {
    await setSidebarWidth(page, 520);
    for (const title of ["orbit-shop", "Outline", "Timeline", "Pinned Items", "Branch Compare"]) {
      await setPaneExpanded(page, title, false);
    }
    await setPaneExpanded(page, "Fresh Files", true);
    const freshFiles = pane(page, "Fresh Files");
    await freshFiles.locator(".monaco-list-row", { hasText: "vendor/payments-sdk" }).first().waitFor({ timeout: 20000 });
    // Pending changes keep the main repo short enough for the submodule nodes to fit.
    await selectTimeWindow(page, "Pending changes");
    await freshFiles.locator(".monaco-list-row", { hasText: "discounts.ts" }).first().waitFor({ state: "detached", timeout: 20000 });
    await freshFiles.locator(".monaco-list-row", { hasText: "currency-data" }).first().waitFor({ timeout: 20000 });
    // The twistie expands without selecting, so no row is highlighted in the shot.
    await freshFiles.locator(".monaco-list-row", { hasText: "Uninitialized submodules" }).first().locator(".monaco-tl-twistie").click();
    await freshFiles.locator(".monaco-list-row", { hasText: "not checked out" }).first().waitFor({ timeout: 20000 });
    await parkMouse(page);
    await page.waitForTimeout(500); // let the last decorations paint
    // Crop to the rendered rows: the pane itself stretches to fill the sidebar.
    const header = await freshFiles.locator(".pane-header").boundingBox();
    const rows = await freshFiles.locator(".monaco-list-row").evaluateAll(els => els.map(e => e.getBoundingClientRect().bottom));
    const bottom = Math.max(...rows) + 6;
    return page.screenshot({ clip: { x: header.x, y: header.y, width: header.width, height: bottom - header.y } });
  },
};
