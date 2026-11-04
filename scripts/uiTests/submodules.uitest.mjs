// Submodules: initialized, nested, and declared-but-not-checked-out, in one fixture.
// Painful to set up by hand, so each case is a test.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildSubmoduleWorkspace } from "../demo/fixtureRepo.mjs";
import { openFile, pane, pickQuickInput, runCommand, selectTimeWindow, setPaneExpanded } from "../demo/vscodeActions.mjs";
import { childrenByRoot, git, treeRows, withVSCode } from "./harness.mjs";

const SDK = "vendor/payments-sdk";
const NESTED = "vendor/payments-sdk/vendor/currency-data";

const rowIn = (page, text) => pane(page, "Fresh Files").locator(".monaco-list-row", { hasText: text }).first();

/** Fresh Files on its own, expanded, in the given time window. */
async function showFreshFiles(page, window) {
  for (const title of ["orbit-shop", "Outline", "Timeline", "Pinned Items", "Fresh Files - Branch Compare"]) {
    await setPaneExpanded(page, title, false);
  }
  await setPaneExpanded(page, "Fresh Files", true);
  await rowIn(page, SDK).waitFor({ timeout: 20000 });
  await selectTimeWindow(page, window);
}

const FLAT = {
  "freshFileExplorer.defaultGroupingMode": "Flat List",
  "freshFileExplorer.flatList.labelStyle": "filename",
  "freshFileExplorer.autoExpandDepth": 5,
};

test("S1: a submodule is its own repo node, holding its own changes", async () => {
  await withVSCode("s1-submodule-node", {
    window: { width: 1100, height: 900 },
    settings: FLAT,
    workspace: ({ stateDir }) => buildSubmoduleWorkspace(join(stateDir, "ws")).main,
  }, async page => {
    await showFreshFiles(page, "Pending changes");
    await rowIn(page, "client.ts").waitFor({ timeout: 20000 });
    const rows = await treeRows(page, "Fresh Files");
    const icons = Object.fromEntries(rows.filter(r => r.level === 1).map(r => [r.label, r.icon]));
    assert.equal(icons["orbit-shop"], "repo");
    assert.equal(icons[SDK], "archive", "submodules get the archive icon, as in Source Control");
    const files = childrenByRoot(rows);
    assert.deepEqual(files[SDK], ["client.ts"]);
    assert.ok(!files["orbit-shop"].includes("client.ts"), "the submodule's file doesn't show under the parent");
    assert.ok(files["orbit-shop"].includes("payments-sdk"), "the parent lists the changed submodule as one entry");
  });
});

test("S2: a submodule that isn't checked out is listed, never scanned", async () => {
  await withVSCode("s2-uninitialized", {
    window: { width: 1100, height: 900 },
    settings: FLAT,
    workspace: ({ stateDir }) => buildSubmoduleWorkspace(join(stateDir, "ws")).main,
  }, async (page, { extensionLog }) => {
    await showFreshFiles(page, "Pending changes");
    const group = rowIn(page, "Uninitialized submodules (1)");
    await group.waitFor({ timeout: 20000 });
    if ((await group.getAttribute("aria-expanded")) !== "true") { await group.click(); }
    await rowIn(page, "not checked out").waitFor();

    const rows = await treeRows(page, "Fresh Files");
    assert.ok(!rows.some(r => r.level === 1 && r.label === "vendor/analytics"), "no repo node for it");
    // git in its empty folder resolves to the parent repo; scanning it would list the parent's files twice.
    assert.equal(rows.filter(r => r.label === "search.ts").length, 1, "the parent's files appear once");
    assert.match(extensionLog(), /Uninitialized submodule \(display only\): vendor\/analytics/);
  });
});

test("S3: a submodule inside a submodule is a repo node of its own", async () => {
  await withVSCode("s3-nested", {
    window: { width: 1100, height: 900 },
    settings: FLAT,
    workspace: ({ stateDir }) => {
      const ws = buildSubmoduleWorkspace(join(stateDir, "ws"));
      writeFileSync(join(ws.nested, "rates.json"), '{ "EUR": 1, "USD": 1.1 }\n');
      return ws.main;
    },
  }, async page => {
    await showFreshFiles(page, "Pending changes");
    await rowIn(page, "rates.json").waitFor({ timeout: 20000 });
    const rows = await treeRows(page, "Fresh Files");
    assert.equal(rows.find(r => r.level === 1 && r.label === NESTED)?.icon, "archive");
    const files = childrenByRoot(rows);
    assert.deepEqual(files[NESTED], ["rates.json"]);
    assert.ok(!files[SDK].includes("rates.json"), "not under the submodule that contains it");
  });
});

test("S4: the baseline heatmap on a submodule file uses the submodule's history", async () => {
  await withVSCode("s4-heatmap-in-submodule", {
    settings: { "typescript.validate.enable": false },
    workspace: ({ stateDir }) => buildSubmoduleWorkspace(join(stateDir, "ws")).main,
  }, async page => {
    await openFile(page, "client.ts");
    await runCommand(page, "Blame Heatmap");
    await pickQuickInput(page, "Baseline");
    const picker = page.locator(".quick-input-widget");
    await picker.locator(".monaco-list-row", { hasText: "sdk-v1" }).waitFor({ timeout: 10000 });
    assert.equal(await picker.locator(".monaco-list-row", { hasText: "v1.0.0" }).count(), 0,
      "the parent's tag v1.0.0 isn't offered: refs come from the submodule");
    await pickQuickInput(page, "sdk-v1");
    await page.locator(".statusbar-item", { hasText: "Heatmap: vs sdk-v1" }).waitFor({ timeout: 10000 });
  });
});

// The commit happens before launch: picking up a commit made in a submodule while VS Code
// runs depends on VS Code's git extension noticing it, which it did in 1 run of 3.
test("S5: a commit inside a submodule shows in it, and as a changed submodule in the parent", async () => {
  await withVSCode("s5-commit-in-submodule", {
    window: { width: 1100, height: 900 },
    settings: { "freshFileExplorer.autoExpandDepth": 5 },
    workspace: ({ stateDir }) => {
      const ws = buildSubmoduleWorkspace(join(stateDir, "ws"));
      writeFileSync(join(ws.sdk, "sdk", "webhooks.ts"), "export function onWebhook() {}\n");
      git(ws.sdk, "add", "sdk/webhooks.ts");
      git(ws.sdk, "commit", "-q", "-m", "Webhooks");
      return ws.main;
    },
  }, async page => {
    await showFreshFiles(page, "1 week");
    await rowIn(page, "webhooks.ts").waitFor({ timeout: 20000 });
    const rows = await treeRows(page, "Fresh Files");
    const files = childrenByRoot(rows);
    assert.ok(files[SDK].includes("webhooks.ts"), "the commit shows under the submodule");
    assert.ok(!files["orbit-shop"].includes("webhooks.ts"), "not under the parent");
    const entry = rows.find(r => r.label === "payments-sdk" && r.description === "submodule");
    assert.ok(entry, "the parent lists the submodule as one changed entry");
  });
});
