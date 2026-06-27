// Pure SVG string builders for blame heatmap gutter icons.
//
// Kept free of `vscode` so the markup logic is unit-testable. The controller
// wraps these in `vscode.Uri.parse(...)` to produce gutter icon URIs.

/**
 * A 16×16 SVG with a full-height colored bar on the right edge, mimicking the
 * GitLens-style gutter indicator. `#` is percent-encoded so the string is safe
 * to embed directly in a `data:image/svg+xml,` URI.
 */
export function gutterBarSvg(hexColor: string): string {
  return `<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16'><rect x='12' y='0' width='2' height='16' fill='${hexColor.replace(/#/g, "%23")}'/></svg>`;
}

/**
 * A deletion badge — a red circle containing the deleted-line count (e.g. "36").
 * No leading minus: the red circle already signals deletion, and dropping it
 * frees budget for the digits to stay readable. `viewBox` lets VS Code scale the
 * SVG to whatever gutter width it allocates. Uses `rgb()` to avoid URL-encoding
 * issues with `#` in data URIs.
 */
export function deletionBadgeSvg(count: number): string {
  const num = count > 999 ? "999+" : String(count);
  // Sized to fit 1–4 chars in a 16-unit circle.
  const fontSize = num.length === 1 ? 11 : num.length === 2 ? 9 : num.length === 3 ? 7 : 6;
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' width='16' height='16'>` +
    `<circle cx='8' cy='8' r='7.5' fill='rgb(248,81,73)'/>` +
    `<text x='8' y='8' text-anchor='middle' dominant-baseline='central' ` +
    `fill='white' font-size='${fontSize}' font-family='sans-serif' font-weight='bold'>${num}</text>` +
    `</svg>`
  );
}
