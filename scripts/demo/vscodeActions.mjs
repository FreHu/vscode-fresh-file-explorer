// Small UI helpers shared by scenes.

/** Runs a command by its exact palette label, e.g. "Set Grouping Mode". */
export async function runCommand(page, label) {
  await page.keyboard.press("F1");
  const input = page.locator(".quick-input-widget input");
  await input.waitFor();
  await input.fill(`>${label}`);
  // Click the row itself: Enter would run whichever result is ranked first.
  await page.locator(".quick-input-list .monaco-list-row", { has: page.getByText(label, { exact: true }) }).first().click();
}

/** Clicks the row of the open quick pick whose label is exactly `label` (descriptions can mention other labels). */
export async function pickQuickInput(page, label) {
  await page.locator(".quick-input-widget .monaco-list-row", { has: page.getByText(label, { exact: true }) }).first().click();
}

/** Opens a workspace file through Quick Open and waits for its editor. */
export async function openFile(page, fileName) {
  await page.keyboard.press("Control+P");
  const input = page.locator(".quick-input-widget input");
  await input.waitFor();
  await input.fill(fileName);
  await page.locator(".quick-input-list .monaco-list-row", { hasText: fileName }).first().click();
  await page.locator(".tab.active", { hasText: fileName }).waitFor();
}

/** Expands or collapses a sidebar section (pane) by its header title, e.g. "Fresh Files". */
export async function setPaneExpanded(page, title, expanded) {
  const header = page.locator(".pane-header", { has: page.locator(".title", { hasText: new RegExp(`^${escapeRegExp(title)}$`, "i") }) }).first();
  await header.waitFor();
  if ((await header.getAttribute("aria-expanded")) !== String(expanded)) {
    await header.click();
  }
}

/** Drags the sash on the sidebar's right edge so the sidebar is `width` pixels wide. */
export async function setSidebarWidth(page, width) {
  const box = await page.locator(".part.sidebar").boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width, y);
  await page.mouse.down();
  await page.mouse.move(box.x + width, y, { steps: 5 });
  await page.mouse.up();
}

/** The pane (header + body) of a sidebar section, for cropping. */
export function pane(page, title) {
  return page.locator(".pane", { has: page.locator(".pane-header .title", { hasText: new RegExp(`^${escapeRegExp(title)}$`, "i") }) }).first();
}

/** Waits until the Fresh Files tree shows a row with this label, i.e. history has loaded. */
export async function waitForFreshFile(page, label, timeout = 30000) {
  await page.locator('[id="workbench.view.explorer"] .monaco-list-row', { hasText: label }).first().waitFor({ timeout });
}

/** Parks the mouse where it can't put hover styling or tooltips into a shot. */
export async function parkMouse(page) {
  await page.mouse.move(1, 1);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
