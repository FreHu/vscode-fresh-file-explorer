import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { annotate, clearAnnotations } from "../annotate.mjs";
import {
  pane, parkMouse, PLAIN_TERMINAL_SETTINGS, runCommand, runInTerminal, setPaneExpanded, setSidebarWidth,
} from "../vscodeActions.mjs";

/** Branch Compare follows a worktree an agent creates, commits in and removes → docs/img/auto-follow-worktree.gif */
export default {
  output: "auto-follow-worktree.gif",
  window: { width: 1100, height: 700 },
  settings: {
    ...PLAIN_TERMINAL_SETTINGS,
    "freshFileExplorer.branchCompare.autoFollow": true,
    "workbench.activityBar.location": "hidden",
    "workbench.panel.opensMaximized": "always",
  },
  // Workspace root → [repo, worktree]: discovery only finds worktrees inside a workspace folder.
  workspace({ stateDir, buildFixtureRepo }) {
    const agents = join(stateDir, "agents");
    rmSync(agents, { recursive: true, force: true });
    mkdirSync(agents, { recursive: true });
    buildFixtureRepo(join(agents, "orbit-shop"));
    return agents;
  },
  async capture(page) {
    await setSidebarWidth(page, 480);
    for (const title of ["agents", "Outline", "Timeline", "Fresh Files", "Pinned Items"]) {
      await setPaneExpanded(page, title, false);
    }
    await setPaneExpanded(page, "Fresh Files - Branch Compare", true);
    const compare = pane(page, "Fresh Files - Branch Compare");
    const section = compare.locator(".monaco-list-row", { hasText: "feature/gift-cards" }).first();
    const row = name => compare.locator(".monaco-list-row", { hasText: name }).first();

    const frames = [];
    const shot = async (holdMs, notes = []) => {
      await parkMouse(page);
      await page.waitForTimeout(400); // tree rows and decorations settle
      await annotate(page, notes);
      frames.push({ png: await page.screenshot(), holdMs });
      await clearAnnotations(page);
    };
    const labelX = 560;

    // 1. The setting, visibly on.
    await runCommand(page, "Branch Compare: Open Comparisons Settings…");
    await parkMouse(page); // the palette row sat where the panel tabs open: its tooltip would show
    const checkbox = page.frameLocator("iframe.webview.ready").frameLocator("#active-frame").locator("#autoFollow");
    await checkbox.waitFor();
    assert.equal(await checkbox.isChecked(), true, "auto-follow must be on for this scene");
    await page.waitForTimeout(1500); // tooltips fade
    await shot(2500, [{ target: { locator: checkbox }, text: "Auto-follow is on", above: 26 }]);

    // 2. An agent adds a worktree on a new branch.
    await runInTerminal(page, "cd orbit-shop && clear");
    await runInTerminal(page, "git worktree add ../orbit-shop-gift-cards -b feature/gift-cards");
    await section.waitFor({ timeout: 20000 });
    await shot(2500, [{ target: { locator: section }, text: "a worktree appeared: followed automatically", labelX }]);

    // 3. It commits there.
    await runInTerminal(page, "cd ../orbit-shop-gift-cards");
    await runInTerminal(page, "echo 'export class GiftCard {}' > src/cart/giftCards.ts");
    await runInTerminal(page, "git add -A && git commit -qm 'Gift cards'");
    await row("giftCards.ts").waitFor({ timeout: 20000 });
    await shot(2500, [{ target: { locator: row("giftCards.ts") }, text: "its commits show up live", labelX }]);

    // 4. Uncommitted work.
    await runInTerminal(page, "echo '// TODO: expiry dates' >> src/cart/cart.ts");
    await row("cart.ts").waitFor({ timeout: 20000 });
    await shot(2500, [{ target: { locator: row("cart.ts") }, text: "uncommitted changes too", labelX }]);

    // 5. Done: the worktree goes, and so does its section.
    await runInTerminal(page, "cd ../orbit-shop && git worktree remove --force ../orbit-shop-gift-cards");
    await section.waitFor({ state: "detached", timeout: 20000 });
    await shot(3000, [{ target: { locator: compare.locator(".pane-header") }, text: "worktree removed: section gone", labelX }]);
    return frames;
  },
};
