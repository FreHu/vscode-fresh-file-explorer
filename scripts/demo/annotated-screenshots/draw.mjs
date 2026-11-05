// annotated-screenshots v0.1.0 — https://github.com/FreHu/annotated-screenshots
// Runs inside the browser via page.evaluate(drawAnnotations, arg): it must not reference
// anything outside its own body. Built with DOM calls only, because pages with a Trusted
// Types or strict CSP policy (VS Code's workbench, many websites) reject HTML strings.

export const DEFAULT_STYLE = {
  accent: "#ffb02e",
  ink: "#1b1b1b",
  font: '600 13px "Segoe UI", system-ui, sans-serif',
};

/**
 * @param {{ items: object[], style: typeof DEFAULT_STYLE, rootId: string, mode: "overlay" | "compose", scale?: number }} arg
 *   `items` carry a resolved `rect` each (see targets.mjs). "overlay" pins the drawing to the
 *   viewport of a live page; "compose" draws over an image at the document origin, scaled by
 *   `scale` (image pixels per CSS pixel of the captured page).
 */
export function drawAnnotations({ items, style, rootId, mode, scale = 1 }) {
  const svgNs = "http://www.w3.org/2000/svg";
  // `all: initial` first, so the page's own CSS (resets, fonts, transforms) can't restyle the drawing.
  const reset = el => { el.style.setProperty("all", "initial"); return el; };
  document.getElementById(rootId)?.remove();
  const root = reset(document.createElement("div"));
  root.id = rootId;
  Object.assign(root.style, {
    position: mode === "overlay" ? "fixed" : "absolute", left: "0", top: "0",
    width: mode === "overlay" ? "100vw" : `${document.documentElement.scrollWidth / scale}px`,
    height: mode === "overlay" ? "100vh" : `${document.documentElement.scrollHeight / scale}px`,
    pointerEvents: "none", zIndex: "2147483647", transform: scale === 1 ? "none" : `scale(${scale})`, transformOrigin: "0 0",
  });
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  Object.assign(svg.style, { position: "absolute", left: "0", top: "0", overflow: "visible" });
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
    const el = reset(document.createElement("div"));
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
      const el = reset(document.createElement("div"));
      Object.assign(el.style, {
        position: "absolute", left: `${b.x - 4}px`, top: `${b.y - 3}px`, width: `${b.width + 8}px`, height: `${b.height + 6}px`,
        border: `2px solid ${style.accent}`, borderRadius: "6px", boxSizing: "border-box",
      });
      root.append(el);
      if (item.text && item.above !== undefined) {
        label(item.text, b.x + b.width / 2, b.y - 3 - item.above, "above");
      } else if (item.text && item.below !== undefined) {
        label(item.text, b.x + b.width / 2, b.y + b.height + 3 + item.below, "below");
      } else if (item.text) {
        label(item.text, b.x + b.width + 16, b.y + b.height / 2, "right");
      }
      continue;
    }
    if (item.marker !== undefined) {
      const el = reset(document.createElement("div"));
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
}
