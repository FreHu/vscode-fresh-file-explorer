// annotated-screenshots v0.1.0 — https://github.com/FreHu/annotated-screenshots
// Turns an annotation target into a rectangle in CSS pixels. Measured from the live page,
// so a rerun after a UI change still points at the right element.

/**
 * Where an annotation points. One of:
 *   { locator }               any Playwright locator; callouts start at its right edge, `above`/`below` use its full width
 *   { locators: [a, b] }      the rectangle around several elements (use with `box: true`)
 *   { rect: {x, y, width, height} }   fixed coordinates in CSS pixels, e.g. for a screenshot taken elsewhere
 * Adapters can add their own kinds (see vscode-targets.mjs) by passing `resolve` to measure().
 */

/**
 * @param {import("playwright").Page} page
 * @param {object} target
 * @param {{ fullPage?: boolean, resolve?: (page, target) => Promise<object | undefined> }} [options]
 *   `fullPage`: the screenshot will be taken with `fullPage: true`, so add the scroll offset
 *   (locator boxes are relative to the viewport).
 */
export async function measure(page, target, { fullPage = false, resolve } = {}) {
  const rect = (resolve && await resolve(page, target)) ?? await resolveBuiltIn(target);
  if (!fullPage) { return rect; }
  const { sx, sy } = await page.evaluate(() => ({ sx: window.scrollX, sy: window.scrollY }));
  const shift = r => r && { ...r, x: r.x + sx, y: r.y + sy };
  return { ...shift(rect), box: shift(rect.box) };
}

async function resolveBuiltIn(target) {
  if (target.rect) {
    const b = target.rect;
    return { x: b.x + b.width + 4, y: b.y, width: 0, height: b.height, box: b };
  }
  if (target.locators) {
    const boxes = [];
    for (const l of target.locators) { boxes.push(await box(l)); }
    const x = Math.min(...boxes.map(b => b.x));
    const y = Math.min(...boxes.map(b => b.y));
    const b = {
      x, y,
      width: Math.max(...boxes.map(b => b.x + b.width)) - x,
      height: Math.max(...boxes.map(b => b.y + b.height)) - y,
    };
    return { ...b, x: b.x + b.width + 4, width: 0, box: b };
  }
  if (target.locator) {
    const b = await box(target.locator);
    return { ...b, x: b.x + b.width + 4, width: 0, box: b };
  }
  throw new Error(`unknown annotation target: ${JSON.stringify(Object.keys(target))}`);
}

async function box(locator) {
  // boundingBox() is relative to the main frame's viewport, also for elements inside iframes.
  const b = await locator.boundingBox();
  if (!b) { throw new Error(`annotation target not visible: ${locator}`); }
  return b;
}
