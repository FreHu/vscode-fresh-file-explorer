// annotated-screenshots v0.1.0 — https://github.com/FreHu/annotated-screenshots
// Extra annotation targets for VS Code's editor (Monaco). Pass as `resolve`:
//   annotate(page, items, { resolve: resolveEditorTarget })
//
//   { editorLine: 17 }          end of that line's text
//   { editorLines: [21, 25] }   a bracket after the longest of those lines
//   { editorGutter: 32 }        the glyph margin of that line (where badges and breakpoints live)

export async function resolveEditorTarget(page, target) {
  if (target.editorLine === undefined && target.editorLines === undefined && target.editorGutter === undefined) {
    return undefined;
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
