import type { StonksDataPoint } from "./messages";
import { plural } from "../utils/plural";

export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * A commit's day of week and hour in the *committer's* local time, not the
 * viewer's. `d.date` is a UTC instant and `d.tzOffsetMinutes` the original
 * `%aI` offset: shifting by it and reading the UTC fields gives the committer's
 * wall clock without the viewer's time zone leaking in. Falls back to UTC when
 * the offset is missing (older cached data).
 */
export function committerLocalDayHour(d: StonksDataPoint): { day: number; hour: number } {
  const shifted = new Date(new Date(d.date).getTime() + (d.tzOffsetMinutes ?? 0) * 60_000);
  return { day: shifted.getUTCDay(), hour: shifted.getUTCHours() };
}

/**
 * Which commits the heatmap counts. A hovered author chip previews that author
 * alone and wins over the saved selection; `selected` undefined means everyone.
 */
export function heatmapAuthorFilter(selected: readonly string[] | undefined, hovered: string | undefined): (d: StonksDataPoint) => boolean {
  if (hovered !== undefined) { return d => d.author === hovered; }
  if (selected === undefined) { return () => true; }
  return d => d.author !== undefined && selected.includes(d.author);
}

export interface HeatmapOptions {
  matches: (d: StonksDataPoint) => boolean;
  workdayStart: number;
  workdayEnd: number;
}

/** 7 × 24 grid of commit counts by day and hour, with the Mon–Fri workday outlined. */
export function renderActivityHeatmap(
  data: StonksDataPoint[], top: number, bandH: number, plotW: number,
  pad: { left: number }, opts: HeatmapOptions,
): string {
  const grid: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const d of data) {
    if (!opts.matches(d)) { continue; }
    const { day, hour } = committerLocalDayHour(d);
    grid[day][hour]++;
  }
  const maxCount = Math.max(...grid.flat(), 1);
  const cellW = plotW / 24;
  const cellH = bandH / 7;
  let out = "";
  for (let day = 0; day < 7; day++) {
    const cellY = top + day * cellH;
    out += `<text x="${pad.left - 10}" y="${cellY + cellH / 2 + 4}" text-anchor="end" fill="var(--vscode-descriptionForeground)" font-size="10">${DAY_LABELS[day]}</text>`;
    for (let hour = 0; hour < 24; hour++) {
      const count = grid[day][hour];
      const cellX = pad.left + hour * cellW;
      const opacity = count === 0 ? 0.06 : 0.1 + (count / maxCount) * 0.8;
      const fill = count === 0 ? "var(--vscode-editorWidget-border, #444)" : "var(--vscode-charts-orange, #ffa94d)";
      const clickable = count > 0 ? ` class="heatmap-cell" data-day="${day}" data-hour="${hour}" style="cursor:pointer"` : "";
      out += `<rect${clickable} x="${(cellX + 1).toFixed(1)}" y="${(cellY + 1).toFixed(1)}" width="${(cellW - 2).toFixed(1)}" height="${(cellH - 2).toFixed(1)}" fill="${fill}" opacity="${opacity.toFixed(2)}" rx="1"><title>${DAY_LABELS[day]} ${hour}:00 — ${plural(count, "commit")} (click to copy hashes)</title></rect>`;
    }
  }
  // Workday outline: rows 1..5 are Mon–Fri (getUTCDay: 0 = Sun). Off-hours cells stand out against it.
  if (opts.workdayEnd > opts.workdayStart) {
    const ox = pad.left + opts.workdayStart * cellW;
    const oy = top + 1 * cellH;
    const ow = (opts.workdayEnd - opts.workdayStart) * cellW;
    const oh = 5 * cellH;
    out += `<rect x="${ox.toFixed(1)}" y="${oy.toFixed(1)}" width="${ow.toFixed(1)}" height="${oh.toFixed(1)}" fill="none" stroke="var(--vscode-foreground)" stroke-width="1.5" stroke-dasharray="4 2" opacity="0.55" pointer-events="none"><title>Workday: Mon–Fri ${opts.workdayStart}:00–${opts.workdayEnd}:00</title></rect>`;
  }
  for (const h of [0, 6, 12, 18]) {
    const x = pad.left + h * cellW + cellW / 2;
    out += `<text x="${x.toFixed(1)}" y="${(top + bandH + 12).toFixed(1)}" text-anchor="middle" fill="var(--vscode-descriptionForeground)" font-size="9">${h}:00</text>`;
  }
  return out;
}
