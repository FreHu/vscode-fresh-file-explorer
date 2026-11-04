import {
  paneClip, parkMouse, selectTimeWindow, setPaneExpanded, setSidebarWidth, showOnlyFreshFiles, waitForFreshFile,
} from "../vscodeActions.mjs";

/** Pinned Items with files, a Markdown outline and notes → docs/img/pinned.png */
export default {
  output: "pinned.png",
  settings: {
    "freshFileExplorer.autoExpandDepth": 5,
    "freshFileExplorer.pinned.headingDepth": 2,
    "freshFileExplorer.pinned.headingExpandDepth": 2,
  },
  async capture(page) {
    await setSidebarWidth(page, 480);
    await showOnlyFreshFiles(page, "discounts.ts");
    await selectTimeWindow(page, "3 months");
    await waitForFreshFile(page, "architecture.md");

    const freshRow = name => page.locator('[id="workbench.view.explorer"] .monaco-list-row', { hasText: name }).first();
    for (const name of ["architecture.md", "payment.ts"]) {
      await freshRow(name).click({ button: "right" });
      await pickContextMenu(page, "Pin File");
    }

    await setPaneExpanded(page, "Fresh Files", false);
    await setPaneExpanded(page, "Pinned Items", true);
    for (const note of ["Ask Bo about retry limits", "Update the payment docs"]) {
      const header = page.locator(".pane-header", { has: page.locator(".title", { hasText: /^Pinned Items$/i }) });
      await header.hover();
      await header.locator('.action-label[aria-label^="Add Note"]').click();
      const input = page.locator(".quick-input-widget input");
      await input.fill(note);
      await input.press("Enter");
      await pinnedRow(page, note).waitFor();
    }
    // Check off the second note.
    await pinnedRow(page, "Update the payment docs").locator(".custom-view-tree-node-item-checkbox").click();

    await pinnedRow(page, "Storefront").waitFor(); // the outline of the pinned Markdown file
    await parkMouse(page);
    await page.waitForTimeout(500);
    return page.screenshot({ clip: await paneClip(page, "Pinned Items") });
  },
};

function pinnedRow(page, text) {
  return page.locator(".pane", { has: page.locator(".pane-header .title", { hasText: /^Pinned Items$/i }) })
    .locator(".monaco-list-row", { hasText: text }).first();
}

async function pickContextMenu(page, label) {
  const menu = page.locator(".monaco-menu").first();
  await menu.locator(".action-item", { has: page.getByText(label, { exact: true }) }).click();
}

