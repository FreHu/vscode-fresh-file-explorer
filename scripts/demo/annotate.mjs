// Draws annotations over the VS Code window before a screenshot. Targets are
// resolved from the live UI, so a rerun after a UI change still points at the
// right element. Built with DOM calls: the workbench's Trusted Types policy
// rejects HTML strings.

const STYLE = {
  accent: "#ffb02e",
  ink: "#1b1b1b",
  font: '600 13px "Segoe UI", system-ui, sans-serif',
};

/**
 * Where an annotation points. One of:
 *   { editorLine: 17 }             end of that line's text
 *   { editorLines: [21, 25] }      a bracket after the longest of those lines
 *   { editorGutter: 32 }           the glyph margin of that line (badges live there)
 *   { locator }                    any Playwright locator; points at its right edge
 *   { locators: [a, b] }           the rectangle around several elements (use with `box: true`)
 */

/**
 * @param {import("playwright-core").Page} page
 * @param {Array<{ target: object, text?: string, marker?: number, labelX?: number, above?: number }>} annotations
 *   `text` draws a callout label at `labelX` (same height as the target), or `above` / `below` px from it.
 *   `marker` draws a numbered circle on the target instead; `box: true` outlines it (label to its right).
 */
export async function annotate(page, annotations) {
  const resolved = [];
  for (const a of annotations) {
    resolved.push({ ...a, target: undefined, rect: await resolveTarget(page, a.target) });
  }
  await page.evaluate(({ items, style }) => {
    const svgNs = "http://www.w3.org/2000/svg";
    document.getElementById("demo-annotations")?.remove();
    const root = document.createElement("div");
    root.id = "demo-annotations";
    Object.assign(root.style, { position: "fixed", inset: "0", pointerEvents: "none", zIndex: "100000" });
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("width", String(window.innerWidth));
    svg.setAttribute("height", String(window.innerHeight));
    Object.assign(svg.style, { position: "absolute", inset: "0" });
    root.append(svg);

    const line = (x1, y1, x2, y2) => {
      const l = document.createElementNS(svgNs, "line");
      for (const [k, v] of Object.entries({ x1, y1, x2, y2 })) { l.setAttribute(k, String(v)); }
      l.setAttribute("stroke", style.accent);
      l.setAttribute("stroke-width", "2");
      l.setAttribute("stroke-linecap", "round");
      svg.append(l);
    };
    const dot = (cx, cy, r) => {
      const c = document.createElementNS(svgNs, "circle");
      for (const [k, v] of Object.entries({ cx, cy, r })) { c.setAttribute(k, String(v)); }
      c.setAttribute("fill", style.accent);
      svg.append(c);
    };
    const label = (text, x, y, anchor) => {
      const el = document.createElement("div");
      el.textContent = text;
      Object.assign(el.style, {
        position: "absolute", left: `${x}px`, top: `${y}px`, font: style.font, color: style.ink,
        background: style.accent, padding: "3px 9px", borderRadius: "6px", whiteSpace: "nowrap",
        boxShadow: "0 2px 8px rgba(0,0,0,.45)",
        transform: anchor === "above" ? "translate(-50%, -100%)" : anchor === "below" ? "translate(-50%, 0)" : "translate(0, -50%)",
      });
      root.append(el);
    };

    for (const item of items) {
      const r = item.rect;
      if (item.box) {
        const b = r.box ?? r;
        const el = document.createElement("div");
        Object.assign(el.style, {
          position: "absolute", left: `${b.x - 4}px`, top: `${b.y - 3}px`, width: `${b.width + 8}px`, height: `${b.height + 6}px`,
          border: `2px solid ${style.accent}`, borderRadius: "6px", boxSizing: "border-box",
        });
        root.append(el);
        if (item.text) { label(item.text, b.x + b.width + 16, b.y + b.height / 2, "right"); }
        continue;
      }
      if (item.marker !== undefined) {
        const el = document.createElement("div");
        el.textContent = String(item.marker);
        Object.assign(el.style, {
          position: "absolute", left: `${r.x}px`, top: `${r.y + r.height / 2}px`, transform: "translate(-50%, -50%)",
          width: "22px", height: "22px", lineHeight: "22px", textAlign: "center", borderRadius: "50%",
          font: style.font, color: style.ink, background: style.accent, boxShadow: "0 2px 8px rgba(0,0,0,.45)",
        });
        root.append(el);
        continue;
      }
      if (r.bracket) {
        const bx = r.x + 10;
        line(bx, r.y + 2, bx, r.y + r.height - 2);
        line(bx - 5, r.y + 2, bx, r.y + 2);
        line(bx - 5, r.y + r.height - 2, bx, r.y + r.height - 2);
      }
      const tx = r.bracket ? r.x + 10 : r.x;
      const ty = r.y + r.height / 2;
      if (item.above !== undefined) {
        const cx = r.box ? r.box.x + r.box.width / 2 : r.x;
        dot(cx, r.y, 3.5);
        line(cx, r.y, cx, r.y - item.above);
        label(item.text, cx, r.y - item.above, "above");
      } else if (item.below !== undefined) {
        const cx = r.box ? r.box.x + r.box.width / 2 : r.x;
        const bottom = r.box ? r.box.y + r.box.height : r.y + r.height;
        dot(cx, bottom, 3.5);
        line(cx, bottom, cx, bottom + item.below);
        label(item.text, cx, bottom + item.below, "below");
      } else {
        dot(tx, ty, 3.5);
        line(tx, ty, item.labelX, ty);
        label(item.text, item.labelX, ty, "right");
      }
    }
    document.body.append(root);
  }, { items: resolved, style: STYLE });
}

/** Removes the annotations, before the next frame of an animated scene. */
export async function clearAnnotations(page) {
  await page.evaluate(() => document.getElementById("demo-annotations")?.remove());
}

async function resolveTarget(page, target) {
  if (target.locators) {
    // The rectangle around several elements, e.g. a group of menu entries.
    const boxes = [];
    for (const l of target.locators) {
      const b = await l.boundingBox();
      if (!b) { throw new Error("annotation target not visible"); }
      boxes.push(b);
    }
    const x = Math.min(...boxes.map(b => b.x));
    const y = Math.min(...boxes.map(b => b.y));
    const box = {
      x, y,
      width: Math.max(...boxes.map(b => b.x + b.width)) - x,
      height: Math.max(...boxes.map(b => b.y + b.height)) - y,
    };
    return { ...box, x: box.x + box.width + 4, width: 0, box };
  }
  if (target.locator) {
    const box = await target.locator.boundingBox();
    if (!box) { throw new Error("annotation target not visible"); }
    // Callouts to the right start at the element's right edge; `above` uses its full width.
    return { ...box, x: box.x + box.width + 4, width: 0, box };
  }
  const [from, to] = target.editorLines ?? [target.editorLine ?? target.editorGutter, target.editorLine ?? target.editorGutter];
  const rect = await page.evaluate(({ from, to, gutter }) => {
    // Line numbers and rendered lines share their vertical position; match on it.
    const editor = document.querySelector(".editor-instance .monaco-editor") ?? document.querySelector(".monaco-editor");
    const numbers = [...editor.querySelectorAll(".line-numbers")];
    const rows = numbers.filter(n => Number(n.textContent) >= from && Number(n.textContent) <= to).map(n => n.getBoundingClientRect());
    if (rows.length === 0) { return undefined; }
    const top = Math.min(...rows.map(r => r.top));
    const bottom = Math.max(...rows.map(r => r.bottom));
    if (gutter) {
      // Start right of the line number, so neither the badge nor the number is covered.
      const number = numbers.find(n => Number(n.textContent) === from).getBoundingClientRect();
      return { x: number.right + 6, y: top, width: 0, height: bottom - top };
    }
    let right = 0;
    for (const viewLine of editor.querySelectorAll(".view-lines .view-line")) {
      const r = viewLine.getBoundingClientRect();
      if (r.top < top - 1 || r.bottom > bottom + 1) { continue; }
      const spans = viewLine.querySelectorAll("span span");
      const last = spans[spans.length - 1];
      if (last) { right = Math.max(right, last.getBoundingClientRect().right); }
    }
    return { x: right + 8, y: top, width: 0, height: bottom - top };
  }, { from, to, gutter: target.editorGutter !== undefined });
  if (!rect) { throw new Error(`editor line ${from} not rendered`); }
  return { ...rect, bracket: target.editorLines !== undefined };
}
