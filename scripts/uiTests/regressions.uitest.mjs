// Regressions found while regenerating the README screenshots. Each failed in the
// real UI while every extension-host test passed, and each test fails with its fix
// undone. (The collapsed-repo regression is timing-dependent in the UI; its test is
// src/test/repoNodeExpanded.test.ts.)

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { addDivergedRemote } from "../demo/fixtureRepo.mjs";
import { openFile, pane, pickQuickInput, runCommand, setPaneExpanded } from "../demo/vscodeActions.mjs";
import { withVSCode } from "./harness.mjs";

const freshFilesRow = (page, text) => pane(page, "Fresh Files").locator(".monaco-list-row", { hasText: text }).first();

test("a repo the git extension opens late still gets its sync warnings", async () => {
  await withVSCode("sync-warnings", {
    workspace({ stateDir, buildFixtureRepo }) {
      const repo = buildFixtureRepo(join(stateDir, "orbit-shop"));
      addDivergedRemote(repo, join(stateDir, "remote", "orbit-shop.git"));
      return repo;
    },
  }, async page => {
    await setPaneExpanded(page, "Fresh Files", true);
    await freshFilesRow(page, "3 commits behind origin/main").waitFor({ timeout: 20000 });
    await freshFilesRow(page, "1 unpushed commit").waitFor({ timeout: 5000 });
  });
});

test("a deletion git folds into an edit gets a badge you can copy, not restore", async () => {
  await withVSCode("folded-deletion", {
    settings: { "typescript.validate.enable": false, "editor.minimap.enabled": false },
    workspace({ stateDir, buildFixtureRepo }) {
      const repo = buildFixtureRepo(join(stateDir, "orbit-shop"));
      // Edit pay()'s last line, right above where isRefundable was deleted since v1.0.0:
      // git reports both in one hunk (@@ -24,5 +30 @@), 4 lines removed beyond the edit.
      const file = join(repo, "src/checkout/payment.ts");
      writeFileSync(file, readFileSync(file, "utf8").replace(
        "  return { ok: true, reference: response.reference };",
        "  return { ok: true, reference: formatReference(response.reference) };",
      ));
      execFileSync("git", ["commit", "-q", "-m", "Format references", "--", "src/checkout/payment.ts"], { cwd: repo });
      return repo;
    },
  }, async page => {
    await runCommand(page, "View: Close Primary Side Bar");
    await openFile(page, "payment.ts");
    await runCommand(page, "Blame Heatmap");
    await pickQuickInput(page, "Baseline");
    await pickQuickInput(page, "v1.0.0");
    await page.locator(".statusbar-item", { hasText: "Heatmap: vs v1.0.0" }).waitFor();
    await page.keyboard.press("Control+End");

    // The badge sits on line 31, under the edit (the edited line has the heatmap's own gutter mark).
    const badgeLines = await page.waitForFunction(() => {
      const editor = document.querySelector(".editor-instance .monaco-editor");
      const lineTop = n => [...editor.querySelectorAll(".line-numbers")].find(e => e.textContent === String(n))?.getBoundingClientRect().top;
      const glyphTops = [...editor.querySelectorAll(".cgmr")].map(e => Math.round(e.getBoundingClientRect().top));
      const top31 = lineTop(31);
      return top31 !== undefined && glyphTops.some(t => Math.abs(t - top31) < 3) ? true : undefined;
    }, undefined, { timeout: 15000 });
    assert.ok(await badgeLines.jsonValue(), "a gutter badge is drawn on line 31");

    await page.locator(".margin-view-overlays .line-numbers", { hasText: /^31$/ }).first().click({ button: "right" });
    const menu = page.locator(".monaco-menu").first();
    await menu.waitFor();
    const entry = label => menu.locator(".action-item", { has: page.getByText(label, { exact: true }) });
    assert.equal(await entry("Copy baseline lines").count(), 1, "Copy is offered");
    assert.equal(await entry("Restore from baseline").count(), 0, "Restore would duplicate the edit");
  });
});
