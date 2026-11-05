// Worktrees: a workspace folder holding a repo and linked worktrees next to it, the
// layout parallel agents use. Painful to set up by hand, so each case is a test.

import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildWorktreeWorkspace } from "../demo/fixtureRepo.mjs";
import { openFile, pane, pickQuickInput, runCommand, selectTimeWindow, setPaneExpanded } from "../demo/vscodeActions.mjs";
import { childrenByRoot, git, treeRows, waitForLog, withVSCode } from "./harness.mjs";

const FLAT_PENDING = {
  "freshFileExplorer.defaultGroupingMode": "Flat List",
  "freshFileExplorer.flatList.labelStyle": "filename",
  "freshFileExplorer.autoExpandDepth": 5,
};

/** Fresh Files on its own, on pending changes, flat: each repo node lists its uncommitted files. */
async function showPendingFlat(page) {
  for (const title of ["agents", "Outline", "Timeline", "Pinned Items", "Fresh Files - Branch Compare"]) {
    await setPaneExpanded(page, title, false);
  }
  await setPaneExpanded(page, "Fresh Files", true);
  await rowIn(page, "Fresh Files", "orbit-shop").waitFor({ timeout: 20000 });
  await selectTimeWindow(page, "Pending changes");
  // Committed 4h ago, not pending: once it's gone, the tree shows the new window.
  await rowIn(page, "Fresh Files", "discounts.ts").waitFor({ state: "detached", timeout: 20000 });
}

const rowIn = (page, paneTitle, text) => pane(page, paneTitle).locator(".monaco-list-row", { hasText: text }).first();
const repoRow = (page, label) => pane(page, "Fresh Files").locator(".monaco-list-row[aria-level='1']", {
  has: page.locator(".label-name", { hasText: new RegExp(`^${label}$`) }),
});

test("W1: each worktree is its own repo node, with only its own pending files", async () => {
  await withVSCode("w1-worktree-nodes", {
    window: { width: 1100, height: 900 },
    settings: FLAT_PENDING,
    workspace: ({ stateDir }) => buildWorktreeWorkspace(join(stateDir, "agents"), {
      "gift-cards": { "src/cart/giftVoucher.ts": "export class GiftVoucher {}\n" },
      search: { "src/catalog/products.ts": "export const products = [{ id: 1 }, { id: 2 }];\n" },
    }).root,
  }, async page => {
    await showPendingFlat(page);
    await rowIn(page, "Fresh Files", "giftVoucher.ts").waitFor({ timeout: 20000 });
    await rowIn(page, "Fresh Files", "products.ts").waitFor({ timeout: 20000 });
    const rows = await treeRows(page, "Fresh Files");
    // History keeps loading in the background for the other windows; pending changes don't wait for it.
    assert.deepEqual(rows.filter(r => r.label.startsWith("Loading history")), [], "no history spinner on pending changes");
    const icons = Object.fromEntries(rows.filter(r => r.level === 1).map(r => [r.label, r.icon]));
    assert.deepEqual(icons, { "orbit-shop": "repo", "orbit-shop-gift-cards": "worktree", "orbit-shop-search": "worktree" });

    const files = childrenByRoot(rows);
    assert.deepEqual(files["orbit-shop-gift-cards"], ["giftVoucher.ts"]);
    assert.deepEqual(files["orbit-shop-search"], ["products.ts"]);
    assert.ok(files["orbit-shop"].includes("search.ts"), "the main checkout keeps its own pending files");
    assert.ok(!files["orbit-shop"].includes("giftVoucher.ts") && !files["orbit-shop"].includes("products.ts"),
      "no worktree file shows under the main checkout");
  });
});

test("W2: a worktree added while VS Code runs appears without a refresh", async () => {
  let main;
  await withVSCode("w2-worktree-added", {
    settings: FLAT_PENDING,
    workspace: ({ stateDir }) => {
      const ws = buildWorktreeWorkspace(join(stateDir, "agents"));
      main = ws.main;
      return ws.root;
    },
  }, async page => {
    await showPendingFlat(page);
    const dir = join(main, "..", "orbit-shop-hotfix");
    git(main, "worktree", "add", "-q", dir, "-b", "hotfix/checkout");
    writeFileSync(join(dir, "HOTFIX.md"), "# Hotfix\n");

    await repoRow(page, "orbit-shop-hotfix").waitFor({ timeout: 20000 });
    await rowIn(page, "Fresh Files", "HOTFIX.md").waitFor({ timeout: 20000 });
    const rows = await treeRows(page, "Fresh Files");
    assert.equal(rows.find(r => r.label === "orbit-shop-hotfix")?.icon, "worktree");
  });
});

test("W3: a removed worktree disappears, with no errors logged", async () => {
  let ws;
  await withVSCode("w3-worktree-removed", {
    settings: FLAT_PENDING,
    workspace: ({ stateDir }) => {
      ws = buildWorktreeWorkspace(join(stateDir, "agents"), {
        "gift-cards": { "src/cart/giftVoucher.ts": "export class GiftVoucher {}\n" },
      });
      return ws.root;
    },
  }, async (page, { extensionLog }) => {
    await showPendingFlat(page);
    await repoRow(page, "orbit-shop-gift-cards").waitFor({ timeout: 20000 });

    git(ws.main, "worktree", "remove", "--force", ws.worktrees["gift-cards"]);
    await repoRow(page, "orbit-shop-gift-cards").waitFor({ state: "detached", timeout: 20000 });
    await rowIn(page, "Fresh Files", "search.ts").waitFor(); // the main checkout is still listed

    const errors = extensionLog().split("\n").filter(l => /\[error\]/i.test(l));
    assert.deepEqual(errors, [], "no errors in the extension log");
  });
});

test("W4: a worktree with a stale .git link is skipped with a warning naming it", async () => {
  await withVSCode("w4-worktree-broken", {
    settings: FLAT_PENDING,
    workspace: ({ stateDir }) => {
      const ws = buildWorktreeWorkspace(join(stateDir, "agents"), { stale: {} });
      // What moving the main checkout leaves behind: the worktree's .git file points nowhere.
      rmSync(join(ws.worktrees.stale, ".git")); // git marks it hidden on Windows, which writeFileSync can't overwrite
      writeFileSync(join(ws.worktrees.stale, ".git"), `gitdir: ${join(ws.root, "moved-away", ".git", "worktrees", "orbit-shop-stale")}\n`);
      return ws.root;
    },
  }, async (page, { extensionLog }) => {
    const toast = page.locator(".notifications-toasts .notification-toast", { hasText: 'skipped "orbit-shop-stale"' });
    await toast.waitFor({ timeout: 20000 });
    assert.equal(await toast.locator(".monaco-button", { hasText: "Copy repair command" }).count(), 1);

    await showPendingFlat(page);
    const roots = (await treeRows(page, "Fresh Files")).filter(r => r.level === 1).map(r => r.label);
    assert.deepEqual(roots, ["orbit-shop"], "only the healthy checkout is listed");
    assert.match(extensionLog(), /Skipping orbit-shop-stale: it has a \.git entry but git does not recognize it/);
  });
});

test("W6: a worktree the git extension never opens still updates live", async () => {
  let ws;
  await withVSCode("w6-worktree-unopened", {
    // The git extension opens no repos at all: every update has to come from Fresh Files' own watcher.
    settings: { ...FLAT_PENDING, "git.autoRepositoryDetection": false },
    workspace: ({ stateDir }) => {
      ws = buildWorktreeWorkspace(join(stateDir, "agents"), {
        "gift-cards": { "src/cart/giftVoucher.ts": "export class GiftVoucher {}\n" },
      });
      return ws.root;
    },
  }, async (page, { extensionLog }) => {
    await showPendingFlat(page);
    await rowIn(page, "Fresh Files", "giftVoucher.ts").waitFor({ timeout: 20000 });
    await waitForLog(extensionLog, /Live updates for .*\/orbit-shop-gift-cards: watching it directly/);
    const dir = ws.worktrees["gift-cards"];

    writeFileSync(join(dir, "src", "cart", "wallet.ts"), "export class Wallet {}\n");
    await rowIn(page, "Fresh Files", "wallet.ts").waitFor({ timeout: 20000 });

    git(dir, "add", "-A");
    git(dir, "-c", "user.name=Ada Okafor", "-c", "user.email=ada@example.com", "commit", "-q", "-m", "Gift cards");
    await rowIn(page, "Fresh Files", "giftVoucher.ts").waitFor({ state: "detached", timeout: 20000 });
    await rowIn(page, "Fresh Files", "wallet.ts").waitFor({ state: "detached", timeout: 20000 });
    await waitForLog(extensionLog, /Live updates for .*\/orbit-shop-gift-cards: HEAD moved to \w+ on feature\/gift-cards/);
    assert.doesNotMatch(extensionLog(), /Git extension (opened|had) repository .*orbit-shop-gift-cards/,
      "the git extension stayed out of it");
  });
});

test("W7: switching a worktree the git extension never opens to its baseline branch flips the heatmap", async () => {
  let ws;
  await withVSCode("w7-heatmap-flip-unopened", {
    settings: { "git.autoRepositoryDetection": false, "typescript.validate.enable": false },
    workspace: ({ stateDir }) => {
      ws = buildWorktreeWorkspace(join(stateDir, "agents"), {
        "gift-cards": { "src/cart/giftVoucher.ts": "export class GiftVoucher {}\n" },
      });
      const dir = ws.worktrees["gift-cards"];
      git(dir, "add", "-A");
      git(dir, "-c", "user.name=Ada Okafor", "-c", "user.email=ada@example.com", "commit", "-q", "-m", "Gift cards");
      git(dir, "branch", "release");
      return ws.root;
    },
  }, async (page, { extensionLog }) => {
    await waitForLog(extensionLog, /Live updates for .*\/orbit-shop-gift-cards: watching it directly/);
    await openFile(page, "giftVoucher.ts");
    await runCommand(page, "Blame Heatmap");
    await pickQuickInput(page, "Baseline");
    await pickQuickInput(page, "release");
    await page.locator(".statusbar-item", { hasText: "Heatmap: vs release" }).waitFor({ timeout: 10000 });

    git(ws.worktrees["gift-cards"], "checkout", "-q", "release");
    await page.locator(".statusbar-item", { hasText: "Heatmap: vs feature/gift-cards" }).waitFor({ timeout: 20000 });
  });
});

test("W5: auto-follow tracks a worktree from creation to removal", async () => {
  let main;
  await withVSCode("w5-auto-follow", {
    settings: { "freshFileExplorer.branchCompare.autoFollow": true },
    workspace: ({ stateDir }) => {
      const ws = buildWorktreeWorkspace(join(stateDir, "agents"));
      main = ws.main;
      return ws.root;
    },
  }, async (page, { extensionLog }) => {
    for (const title of ["agents", "Outline", "Timeline", "Fresh Files", "Pinned Items"]) {
      await setPaneExpanded(page, title, false);
    }
    await setPaneExpanded(page, "Fresh Files - Branch Compare", true);
    const compare = "Fresh Files - Branch Compare";
    const section = () => rowIn(page, compare, "feature/coupons");

    // Add the worktree once startup is done, so this test covers creation (a worktree
    // there from the start is W6).
    await waitForLog(extensionLog, /Discovered 1 Git repository/);
    // On Windows the git extension opens the repo after Fresh Files starts; on Linux it is open already.
    await waitForLog(extensionLog, /Git extension (opened|had) repository .*\/orbit-shop /);
    const dir = join(main, "..", "orbit-shop-coupons");
    git(main, "worktree", "add", "-q", dir, "-b", "feature/coupons");
    await section().waitFor({ timeout: 20000 });
    await rowIn(page, compare, "No commits beyond main yet").waitFor({ timeout: 10000 });

    writeFileSync(join(dir, "src", "cart", "coupons.ts"), "export function validateCoupon() {}\n");
    git(dir, "add", "-A");
    git(dir, "-c", "user.name=Ada Okafor", "-c", "user.email=ada@example.com", "commit", "-q", "-m", "Coupons");
    await rowIn(page, compare, "coupons.ts").waitFor({ timeout: 20000 });

    writeFileSync(join(dir, "src", "cart", "cart.ts"), "export class Cart {}\n// coupons hook\n");
    const cart = rowIn(page, compare, "cart.ts");
    await cart.waitFor({ timeout: 20000 });
    assert.match(await cart.locator(".label-description").innerText(), /•/, "uncommitted change is marked");

    git(main, "worktree", "remove", "--force", dir);
    await section().waitFor({ state: "detached", timeout: 20000 });
  });
});
