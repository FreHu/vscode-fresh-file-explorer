/**
 * Shared utilities for webview panels.
 * Pure/DOM helpers that are duplicated across multiple panels.
 */

/** Escapes a string for safe HTML insertion. */
export function escHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const RAW = Symbol("raw");

/** Marks a string as pre-escaped/trusted so `html` won't escape it. */
export function raw(value: string): { [RAW]: string } {
  return { [RAW]: value };
}

/**
 * HTML tagged template literal — auto-escapes interpolated values.
 * Wrap trusted HTML fragments with raw() to pass them through unescaped.
 *
 * @example
 * html`<div class="msg">${userInput}</div>`
 * html`<div>${raw(trustedHtmlFragment)}</div>`
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  let result = strings[0];
  for (let i = 0; i < values.length; i++) {
    const val = values[i];
    result += (val !== null && typeof val === "object" && RAW in val)
      ? (val as { [RAW]: string })[RAW]
      : escHtml(String(val));
    result += strings[i + 1];
  }
  return result;
}

/**
 * Shows a tooltip element and positions it relative to a container,
 * flipping horizontally when it would overflow the right edge.
 * Call after setting tooltip innerHTML.
 */
export function positionTooltip(
  tooltip: HTMLElement,
  container: HTMLElement,
  clientX: number,
  clientY: number,
): void {
  tooltip.style.display = "block";
  const cRect = container.getBoundingClientRect();
  const tooltipW = tooltip.offsetWidth;
  let tooltipX = clientX - cRect.left + 12;
  if (tooltipX + tooltipW > cRect.width) {
    tooltipX = clientX - cRect.left - tooltipW - 12;
  }
  tooltip.style.left = tooltipX + "px";
  tooltip.style.top = (clientY - cRect.top - tooltip.offsetHeight - 8) + "px";
}
