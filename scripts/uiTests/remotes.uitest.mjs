// Remotes: each test's "origin" is a bare repo on disk, so no network or credentials
// are involved; git fetches, pushes and tracks upstreams the same way over a path.

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { addOrigin, pushFromElsewhere, startFeatureBranch } from "../demo/fixtureRepo.mjs";
import { openFile, pane, pickQuickInput, runCommand, selectTimeWindow, setPaneExpanded } from "../demo/vscodeActions.mjs";
import { openComparisonsPanel } from "../demo/scenes/branchCompareSettings.mjs";
import { git, withVSCode } from "./harness.mjs";

const rowIn = (page, paneTitle, text) => pane(page, paneTitle).locator(".monaco-list-row", { hasText: text }).first();

async function showFreshFiles(page) {
  for (const title of ["orbit-shop", "Outline", "Timeline", "Pinned Items", "Branch Compare"]) {
    await setPaneExpanded(page, title, false);
  }
  await setPaneExpanded(page, "Fresh Files", true);
  await rowIn(page, "Fresh Files", "orbit-shop").waitFor({ timeout: 20000 });
}

const NEWER_ON_MAIN = [
  { author: "bo", daysAgo: 0.3, message: "Release notes for 1.1", files: { "docs/release-notes.md": "# 1.1\n" } },
  { author: "carmen", daysAgo: 0.2, message: "Search tuning", files: { "docs/search-tuning.md": "# Tuning\n" } },
  { author: "bo", daysAgo: 0.1, message: "Payment FAQ", files: { "docs/payment-faq.md": "# FAQ\n" } },
];

/** Fixture repo with an origin, on a feature branch 2 commits ahead, while origin/main moved 3 ahead. */
function featureBehindMain({ stateDir, buildFixtureRepo }) {
  const repo = buildFixtureRepo(join(stateDir, "orbit-shop"));
  const remote = join(stateDir, "remote", "orbit-shop.git");
  addOrigin(repo, remote);
  startFeatureBranch(repo, "feature/coupons");
  pushFromElsewhere(remote, NEWER_ON_MAIN);
  git(repo, "fetch", "-q", "origin");
  return repo;
}

test("R1: a feature branch shows how far it is ahead of and behind its base, origin/main", async () => {
  await withVSCode("r1-base-branch-sync", { workspace: featureBehindMain }, async page => {
    await showFreshFiles(page);
    await rowIn(page, "Fresh Files", "2 commits ahead of base branch 'origin/main'").waitFor({ timeout: 20000 });
    await rowIn(page, "Fresh Files", "3 commits in 'origin/main' not in current branch").waitFor({ timeout: 5000 });
  });
});

test("R2: a fetch that only moves ahead/behind updates the warning without reloading files", async () => {
  let repo, remote;
  await withVSCode("r2-fetch-no-reload", {
    workspace({ stateDir, buildFixtureRepo }) {
      repo = buildFixtureRepo(join(stateDir, "orbit-shop"));
      remote = join(stateDir, "remote", "orbit-shop.git");
      addOrigin(repo, remote);
      return repo;
    },
  }, async (page, { extensionLog }) => {
    await showFreshFiles(page);
    await page.waitForTimeout(3000); // startup events settle before the log is cut
    const before = extensionLog().length;

    pushFromElsewhere(remote, NEWER_ON_MAIN.slice(0, 1));
    git(repo, "fetch", "-q", "origin");
    await rowIn(page, "Fresh Files", "1 commit behind origin/main").waitFor({ timeout: 20000 });
    await page.waitForTimeout(2000);

    const after = extensionLog().slice(before);
    assert.match(after, /sync counts changed, updating sync warnings only/);
    assert.doesNotMatch(after, /Refresh of files|Hard refresh/, "a fetch alone doesn't re-read history");
  });
});

test("R3: after a pull, the new commits show with their authors", async () => {
  let repo;
  await withVSCode("r3-pull", {
    workspace({ stateDir, buildFixtureRepo }) {
      repo = buildFixtureRepo(join(stateDir, "orbit-shop"));
      const remote = join(stateDir, "remote", "orbit-shop.git");
      addOrigin(repo, remote);
      pushFromElsewhere(remote, NEWER_ON_MAIN);
      git(repo, "fetch", "-q", "origin");
      return repo;
    },
  }, async page => {
    await showFreshFiles(page);
    await selectTimeWindow(page, "1 week");
    await rowIn(page, "Fresh Files", "3 commits behind origin/main").waitFor({ timeout: 20000 });
    assert.equal(await rowIn(page, "Fresh Files", "payment-faq.md").count(), 0, "not in the tree before the pull");

    git(repo, "pull", "-q", "--ff-only");
    const faq = rowIn(page, "Fresh Files", "payment-faq.md");
    await faq.waitFor({ timeout: 20000 });
    assert.match(await faq.locator(".label-description").innerText(), /Bo Lindqvist/);
    await rowIn(page, "Fresh Files", "3 commits behind").waitFor({ state: "detached", timeout: 10000 });
  });
});

test("R4: auto-follow finds the base from origin/HEAD when there is no local main", async () => {
  await withVSCode("r4-follow-origin-head", {
    settings: { "freshFileExplorer.branchCompare.autoFollow": true },
    workspace({ stateDir, buildFixtureRepo }) {
      const repo = buildFixtureRepo(join(stateDir, "orbit-shop"));
      addOrigin(repo, join(stateDir, "remote", "orbit-shop.git"));
      startFeatureBranch(repo, "feature/coupons");
      git(repo, "branch", "-q", "-D", "main"); // only origin/main (and origin/HEAD) remain
      return repo;
    },
  }, async page => {
    for (const title of ["orbit-shop", "Outline", "Timeline", "Fresh Files", "Pinned Items"]) {
      await setPaneExpanded(page, title, false);
    }
    await setPaneExpanded(page, "Branch Compare", true);
    const compare = "Branch Compare";
    await rowIn(page, compare, "feature/coupons").waitFor({ timeout: 20000 });
    // The branch's own commits, diffed against origin/main: the base was resolved.
    await rowIn(page, compare, "coupons.ts").waitFor({ timeout: 20000 });
    await rowIn(page, compare, "cart.ts").waitFor({ timeout: 5000 });
  });
});

test("R5: Branch Compare suggests and compares against remote branches", async () => {
  await withVSCode("r5-compare-remote-refs", {
    settings: { "workbench.panel.opensMaximized": "never" },
    workspace(ctx) {
      const repo = featureBehindMain(ctx);
      // A branch that exists only on the remote.
      pushFromElsewhere(join(ctx.stateDir, "remote", "orbit-shop.git"),
        [{ author: "carmen", daysAgo: 0.5, message: "Release prep", files: { "RELEASE.md": "# 1.1\n" } }], Date.now(), "release/1.1");
      git(repo, "fetch", "-q", "origin");
      return repo;
    },
  }, async page => {
    const frame = await openComparisonsPanel(page);
    await frame.locator("#addBtn").click();
    const target = frame.locator("tr.draft-row:last-child .ref-input[data-field='target']");
    await target.fill("origin/rel");
    await frame.locator(".suggest-list .suggest-item", { hasText: "origin/release/1.1" }).waitFor({ timeout: 10000 });
    await page.keyboard.press("Escape");
    await frame.locator("tr.draft-row").first().waitFor();

    // A comparison against origin/main lists the feature branch's own changes.
    await target.fill("origin/main");
    await target.press("Enter");
    await page.keyboard.press("Escape");
    for (const title of ["orbit-shop", "Outline", "Timeline", "Fresh Files", "Pinned Items"]) {
      await setPaneExpanded(page, title, false);
    }
    await setPaneExpanded(page, "Branch Compare", true);
    await rowIn(page, "Branch Compare", "HEAD..origin/main").waitFor({ timeout: 20000 });
    await rowIn(page, "Branch Compare", "coupons.ts").waitFor({ timeout: 20000 });
  });
});

test("R6: the baseline heatmap offers remote branches and colors against origin/main", async () => {
  await withVSCode("r6-heatmap-origin-main", {
    settings: { "typescript.validate.enable": false },
    workspace: featureBehindMain,
  }, async page => {
    await openFile(page, "cart.ts");
    await runCommand(page, "Blame Heatmap");
    await pickQuickInput(page, "Baseline");
    await pickQuickInput(page, "origin/main");
    await page.locator(".statusbar-item", { hasText: "Heatmap: vs origin/main" }).waitFor({ timeout: 10000 });
  });
});
