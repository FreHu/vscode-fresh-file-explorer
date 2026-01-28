/** Helper to normalize path separators to forward slashes */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Build a human-readable label for a number of days
 */
export function formatDaysLabel(days: number): string {
  const dayLabels: Record<number, string> = {
    [-1]: "Pending changes",
    1: "1 day",
    7: "1 week",
    14: "2 weeks",
    30: "1 month",
    60: "2 months",
    90: "3 months",
    180: "6 months",
    365: "1 year",
  };

  if (dayLabels.hasOwnProperty(days)) {
    return dayLabels[days];
  }

  return `${days} days`;
}

export function setDifference<T>(all: Iterable<T>, exclude: Set<T>): Set<T> {
  return new Set(Array.from(all).filter(x => !exclude.has(x)));
}

export function dotsDots(str: string, length = 80): string {
  return str.length > length ? str.substring(0, length - 3) + "..." : str;
}
