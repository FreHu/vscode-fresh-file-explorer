// Generated files: .gitattributes marks them (linguist-generated / gitlab-generated);
// they're labelled in Fresh Files and Branch Compare, and a toggle hides them.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pane, runCommand, selectTimeWindow, setPaneExpanded } from "../demo/vscodeActions.mjs";
import { git, waitForLog, withVSCode } from "./harness.mjs";

const rowIn = (page, paneTitle, text) => pane(page, paneTitle).locator(".monaco-list-row", { hasText: text }).first();

function write(repo, files) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(repo, rel, ".."), { recursive: true });
    writeFileSync(join(repo, rel), content);
  }
}

test("G1: a generated file is labelled in Fresh Files, and the toggle hides it", async () => {
  await withVSCode("g1-generated-fresh-files", {
    settings: {
      "freshFileExplorer.defaultGroupingMode": "Flat List",
      "freshFileExplorer.flatList.labelStyle": "filename",
    },
    workspace({ stateDir, buildFixtureRepo }) {
      const repo = buildFixtureRepo(join(stateDir, "orbit-shop"));
      write(repo, {
        ".gitattributes": "api/*.generated.ts linguist-generated\n",
        "api/client.generated.ts": "export const client = {};\n",
        "api/handwritten.ts": "export const handwritten = {};\n",
      });
      return repo;
    },
  }, async page => {
    for (const title of ["orbit-shop", "Outline", "Timeline", "Pinned Items", "Fresh Files - Branch Compare"]) {
      await setPaneExpanded(page, title, false);
    }
    await setPaneExpanded(page, "Fresh Files", true);
    await selectTimeWindow(page, "Pending changes");
    const generated = rowIn(page, "Fresh Files", "client.generated.ts");
    await generated.locator(".label-description", { hasText: "generated" }).waitFor({ timeout: 20000 });
    assert.doesNotMatch(await rowIn(page, "Fresh Files", "handwritten.ts").locator(".label-description").innerText(), /generated/);

    await runCommand(page, "Show / Hide Generated Files");
    await generated.waitFor({ state: "detached", timeout: 10000 });
    await rowIn(page, "Fresh Files", "handwritten.ts").waitFor();

    await runCommand(page, "Show / Hide Generated Files");
    await generated.waitFor({ timeout: 10000 });
  });
});

test("G2: a generated file is labelled in Branch Compare", async () => {
  await withVSCode("g2-generated-branch-compare", {
    settings: { "freshFileExplorer.branchCompare.autoFollow": true },
    workspace({ stateDir, buildFixtureRepo }) {
      const repo = buildFixtureRepo(join(stateDir, "orbit-shop"));
      git(repo, "checkout", "-q", "-b", "feature/api");
      write(repo, {
        ".gitattributes": "api/*.generated.ts gitlab-generated\n",
        "api/client.generated.ts": "export const client = {};\n",
        "api/handwritten.ts": "export const handwritten = {};\n",
      });
      git(repo, "add", ".gitattributes", "api");
      git(repo, "-c", "user.name=Ada Okafor", "-c", "user.email=ada@example.com", "commit", "-q", "-m", "API client");
      return repo;
    },
  }, async (page, { extensionLog }) => {
    for (const title of ["orbit-shop", "Outline", "Timeline", "Fresh Files", "Pinned Items"]) {
      await setPaneExpanded(page, title, false);
    }
    await setPaneExpanded(page, "Fresh Files - Branch Compare", true);
    await waitForLog(extensionLog, /checked files changed generated status/);
    const compare = "Fresh Files - Branch Compare";
    await rowIn(page, compare, "client.generated.ts").locator(".label-description", { hasText: "generated" }).waitFor({ timeout: 20000 });
    assert.doesNotMatch(await rowIn(page, compare, "handwritten.ts").locator(".label-description").innerText(), /generated/);
  });
});
