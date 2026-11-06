import { randomBytes } from "crypto";
import { html, raw } from "./templateHelpers";

/**
 * Generate a cryptographically random nonce for Content Security Policy.
 * 16 bytes → 22-char base64 (no padding) — well over the 128-bit minimum
 * the CSP spec recommends.
 */
export function getNonce(): string {
  return randomBytes(16).toString("base64");
}

/**
 * The Content-Security-Policy every webview here uses: nothing by default,
 * scripts only from the extension with the page's nonce, fonts only when the
 * codicons stylesheet is loaded. `inlineStyles` allows `style="..."`
 * attributes ('unsafe-inline'); without it only nonce'd `<style>` blocks apply.
 */
export function webviewCsp(opts: { cspSource: string; nonce: string; fonts: boolean; inlineStyles: boolean }): string {
  const { cspSource, nonce } = opts;
  const styleSrc = opts.inlineStyles ? `${cspSource} 'unsafe-inline'` : `${cspSource} 'nonce-${nonce}'`;
  const fontSrc = opts.fonts ? ` font-src ${cspSource};` : "";
  return `default-src 'none'; style-src ${styleSrc}; script-src ${cspSource} 'nonce-${nonce}';${fontSrc}`;
}

/** A webview's `<head>`: charset, viewport, CSP, optional title and codicons stylesheet, then `styles`. */
export function webviewHead(opts: {
  cspSource: string;
  nonce: string;
  styles: string;
  title?: string;
  codiconCssUri?: string;
  /** See {@link webviewCsp}. Default true. */
  inlineStyles?: boolean;
}): string {
  const inlineStyles = opts.inlineStyles ?? true;
  const csp = webviewCsp({ cspSource: opts.cspSource, nonce: opts.nonce, fonts: opts.codiconCssUri !== undefined, inlineStyles });
  const lines = [
    `<head>`,
    `  <meta charset="UTF-8">`,
    `  <meta name="viewport" content="width=device-width, initial-scale=1.0">`,
    html`  <meta http-equiv="Content-Security-Policy" content="${raw(csp)}">`,
  ];
  if (opts.title !== undefined) { lines.push(html`  <title>${opts.title}</title>`); }
  if (opts.codiconCssUri !== undefined) { lines.push(html`  <link rel="stylesheet" href="${raw(opts.codiconCssUri)}">`); }
  lines.push(inlineStyles
    ? html`  <style>${raw(opts.styles)}</style>`
    : html`  <style nonce="${opts.nonce}">${raw(opts.styles)}</style>`);
  lines.push(`</head>`);
  return lines.join("\n");
}
