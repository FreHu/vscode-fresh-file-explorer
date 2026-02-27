/**
 * Pure utility functions for heatmap color computation.
 *
 * Keeping these separate from the VS Code provider class makes them
 * straightforward to unit-test without any extension host mocks.
 *
 * NOTE: The bucket count (8) is intentionally unrelated to the number of
 * configured time windows. The two happen to share the same default count,
 * but are not related.
 */

// age1–age7 are used for files within the active time window (7 in-window buckets).
// age8 is reserved exclusively for files older than the window, keeping the two visually distinct.
// Run the test "getBucketBoundaries prints bucket boundaries" to see exact day ranges per window.

/** Total number of color IDs registered in package.json (age1 … age8). */
export const HEATMAP_BUCKET_COUNT = 8;

/**
 * Number of buckets used for files *within* the time window (age1 … age7).
 * age8 is intentionally reserved for files older than the window so that
 * "oldest fresh files" and "even older than that" are visually distinct.
 */
export const HEATMAP_IN_WINDOW_BUCKETS = HEATMAP_BUCKET_COUNT - 1;

/**
 * The VS Code color ID applied to files outside the active time window.
 * Kept as a named constant so it stays in sync with HEATMAP_BUCKET_COUNT.
 */
export const OUT_OF_WINDOW_COLOR_ID = `freshFileExplorer.heatmap.age${HEATMAP_BUCKET_COUNT}`;

/**
 * Scale a linear age fraction [0, 1] with an exponential curve so that
 * recent files are spread across more buckets than older ones.
 */
export function scaleAgeFraction(ageFraction: number): number {
  return Math.pow(ageFraction, 0.6);
}

/**
 * Map a scaled age fraction [0, 1] to a zero-based bucket index [0, HEATMAP_IN_WINDOW_BUCKETS - 1].
 * 0 = most recent bucket, HEATMAP_IN_WINDOW_BUCKETS-1 = oldest in-window bucket (age7).
 * age8 is NOT produced here; it is reserved for files outside the time window.
 */
export function ageFractionToBucket(scaledFraction: number): number {
  return Math.min(HEATMAP_IN_WINDOW_BUCKETS - 1, Math.floor(scaledFraction * HEATMAP_IN_WINDOW_BUCKETS));
}

/**
 * Compute the heatmap bucket (0-based) for a file given its date, the
 * current time-window length in days, and the reference "now" timestamp.
 *
 * Returns `undefined` when the time window is zero (avoids division by zero)
 * or when the file is a pending change (no date/commit data).
 *
 * @param fileDate     - The date the file was last committed.
 * @param windowDays   - Length of the active historical time window in days.
 * @param nowMs        - Current time as a Unix timestamp in milliseconds.
 */
export function computeHeatmapBucket(
  fileDate: Date,
  windowDays: number,
  nowMs: number
): number {
  const timeWindowMs = windowDays * 24 * 60 * 60 * 1000;

  const ageMs = nowMs - fileDate.getTime();

  // Clamp to [0, 1]: files beyond the window edge stay at bucket HEATMAP_BUCKET_COUNT-1
  const ageFraction = Math.max(0, Math.min(1, ageMs / timeWindowMs));

  const scaledFraction = scaleAgeFraction(ageFraction);
  return ageFractionToBucket(scaledFraction);
}

/**
 * Return the VS Code color ID string for a given zero-based bucket index,
 * e.g. bucket 0 → "freshFileExplorer.heatmap.age1".
 */
export function bucketToColorId(bucket: number): string {
  return `freshFileExplorer.heatmap.age${bucket + 1}`;
}

/**
 * Describes the day-range covered by a single heatmap bucket.
 */
export interface BucketBoundary {
  /** Zero-based bucket index (0 = freshest). */
  bucket: number;
  /** VS Code color ID for this bucket (e.g. "freshFileExplorer.heatmap.age1"). */
  colorId: string;
  /** Start of the bucket in days from now (inclusive). */
  startDays: number;
  /** End of the bucket in days from now (exclusive, except the last bucket). */
  endDays: number;
}

/**
 * Return the day boundaries for every heatmap bucket within a given time window.
 *
 * Useful for documentation, debugging, or rendering a legend.
 *
 * @param windowDays - Length of the active historical time window in days.
 */
export function getBucketBoundaries(windowDays: number): BucketBoundary[] {
  const boundaries: BucketBoundary[] = [];
  for (let k = 0; k < HEATMAP_IN_WINDOW_BUCKETS; k++) {
    // Invert the scale curve: scaled = k/B  =>  ageFraction = scaled^(1/0.6)
    const startDays = Math.pow(k / HEATMAP_IN_WINDOW_BUCKETS, 1 / 0.6) * windowDays;
    const endDays = Math.min(
      Math.pow((k + 1) / HEATMAP_IN_WINDOW_BUCKETS, 1 / 0.6) * windowDays,
      windowDays
    );
    boundaries.push({ bucket: k, colorId: bucketToColorId(k), startDays, endDays });
  }
  return boundaries;
}

/**
 * Compute the color ID for a file given its date,
 * the current time window in days, and the reference "now" timestamp.
 */
export function computeHeatmapColorId(
  fileDate: Date,
  windowDays: number,
  nowMs: number
): string {
  return bucketToColorId(computeHeatmapBucket(fileDate, windowDays, nowMs));
}
