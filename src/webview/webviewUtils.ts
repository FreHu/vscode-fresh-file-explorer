/**
 * Shared utilities for webview panels.
 */

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

/** Show a status message in `el`, coloured for info or error. */
export function showStatusFor(el: HTMLElement, message: string, type: "info" | "error"): void {
  el.textContent = message;
  el.style.color = type === "error" ? "var(--vscode-errorForeground)" : "var(--vscode-descriptionForeground)";
  el.style.display = "";
}

/** Hide a status element. */
export function hideStatusFor(el: HTMLElement): void {
  el.style.display = "none";
}
