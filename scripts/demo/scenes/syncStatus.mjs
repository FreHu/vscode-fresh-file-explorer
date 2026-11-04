import { join } from "node:path";
import { addDivergedRemote } from "../fixtureRepo.mjs";
import { parkMouse, setSidebarWidth, showOnlyFreshFiles } from "../vscodeActions.mjs";

/** Behind / unpushed warnings at the top of the tree → docs/img/sync-status.png */
export default {
  output: "sync-status.png",
  settings: {
    "freshFileExplorer.autoExpandDepth": 5,
  },
  workspace({ stateDir, buildFixtureRepo }) {
    const repo = buildFixtureRepo(join(stateDir, "orbit-shop"));
    addDivergedRemote(repo, join(stateDir, "remote", "orbit-shop.git"));
    return repo;
  },
  async capture(page) {
    await setSidebarWidth(page, 480);
    await showOnlyFreshFiles(page, "discounts.ts");
    const warnings = page.locator('[id="workbench.view.explorer"] .monaco-list-row', { hasText: /behind|unpushed/ });
    await warnings.first().waitFor({ timeout: 30000 });
    await parkMouse(page);
    await page.waitForTimeout(500);
    // The view header plus the warning rows and the repo row under them.
    const header = await page.locator(".pane-header", { has: page.locator(".title", { hasText: /^Fresh Files$/i }) }).boundingBox();
    const rows = await warnings.evaluateAll(els => els.map(e => e.getBoundingClientRect().bottom));
    return page.screenshot({ clip: { x: header.x, y: header.y, width: header.width, height: Math.max(...rows) + 22 + 4 - header.y } });
  },
};
