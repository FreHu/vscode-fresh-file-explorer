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
