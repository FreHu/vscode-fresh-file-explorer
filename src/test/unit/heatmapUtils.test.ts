import * as assert from "assert";
import {
  HEATMAP_BUCKET_COUNT,
  HEATMAP_IN_WINDOW_BUCKETS,
  OUT_OF_WINDOW_COLOR_ID,
  scaleAgeFraction,
  ageFractionToBucket,
  computeHeatmapBucket,
  bucketToColorId,
  computeHeatmapColorId,
  getBucketBoundaries,
} from "../../heatmap/heatmapUtils";

suite("heatmapUtils", () => {
  // Fixed reference point used throughout these tests
  const NOW_MS = new Date("2026-01-15T12:00:00Z").getTime();

  const daysAgo = (days: number): Date =>
    new Date(NOW_MS - days * 24 * 60 * 60 * 1000);

  // ─── HEATMAP_BUCKET_COUNT ────────────────────────────────────────────────

  suite("HEATMAP_BUCKET_COUNT", () => {
    test("is 8 to match the registered color IDs in package.json", () => {
      assert.strictEqual(HEATMAP_BUCKET_COUNT, 8);
    });
  });

  // ─── scaleAgeFraction ───────────────────────────────────────────────────

  suite("scaleAgeFraction", () => {
    test("0 maps to 0 (brand-new file)", () => {
      assert.strictEqual(scaleAgeFraction(0), 0);
    });

    test("1 maps to 1 (file at exact window edge)", () => {
      assert.strictEqual(scaleAgeFraction(1), 1);
    });

    test("applies exponent < 1 so recent files get more buckets than old ones", () => {
      // With exponent 0.6 a file at 50% of the window maps to >50% scaled
      const mid = scaleAgeFraction(0.5);
      assert.ok(mid > 0.5, `expected >0.5, got ${mid}`);
    });
  });

  // ─── ageFractionToBucket ────────────────────────────────────────────────

  suite("ageFractionToBucket", () => {
    test("fraction 0 → bucket 0 (freshest)", () => {
      assert.strictEqual(ageFractionToBucket(0), 0);
    });

    test("fraction 1 → bucket HEATMAP_IN_WINDOW_BUCKETS-1 (age7, not age8 which is reserved)", () => {
      assert.strictEqual(ageFractionToBucket(1), HEATMAP_IN_WINDOW_BUCKETS - 1);
    });

    test("fraction slightly above 1 is clamped to HEATMAP_IN_WINDOW_BUCKETS-1", () => {
      assert.strictEqual(ageFractionToBucket(1.5), HEATMAP_IN_WINDOW_BUCKETS - 1);
    });

    test("never returns a bucket >= HEATMAP_IN_WINDOW_BUCKETS for any input", () => {
      const extremes = [0, 0.001, 0.5, 0.999, 1, 1.001, 100];
      for (const f of extremes) {
        const bucket = ageFractionToBucket(f);
        assert.ok(
          bucket >= 0 && bucket < HEATMAP_IN_WINDOW_BUCKETS,
          `fraction ${f} produced out-of-range bucket ${bucket}`
        );
      }
    });
  });

  // ─── computeHeatmapBucket ───────────────────────────────────────────────

  suite("computeHeatmapBucket", () => {
    const WINDOW_30 = 30;

    test("file committed right now → bucket 0", () => {
      assert.strictEqual(computeHeatmapBucket(new Date(NOW_MS), WINDOW_30, NOW_MS), 0);
    });

    test("file committed in the future → bucket 0 (negative age clamped)", () => {
      const future = new Date(NOW_MS + 5 * 24 * 60 * 60 * 1000);
      assert.strictEqual(computeHeatmapBucket(future, WINDOW_30, NOW_MS), 0);
    });

    test("file at exact window edge → bucket HEATMAP_IN_WINDOW_BUCKETS-1 (age7)", () => {
      assert.strictEqual(
        computeHeatmapBucket(daysAgo(30), WINDOW_30, NOW_MS),
        HEATMAP_IN_WINDOW_BUCKETS - 1
      );
    });

    test("file older than window → clamped to HEATMAP_IN_WINDOW_BUCKETS-1 (age7)", () => {
      assert.strictEqual(
        computeHeatmapBucket(daysAgo(60), WINDOW_30, NOW_MS),
        HEATMAP_IN_WINDOW_BUCKETS - 1
      );
    });

    test("file at 50% of window falls in middle buckets (3 or 4)", () => {
      // ageFraction=0.5, scaled=0.5^0.6≈0.659, bucket=floor(0.659*7)=4
      const bucket = computeHeatmapBucket(daysAgo(15), WINDOW_30, NOW_MS);
      assert.ok(bucket >= 3 && bucket <= 4, `expected 3 or 4, got ${bucket}`);
    });

    test("file at 25% of window falls in earlier buckets (2 or 3)", () => {
      // ageFraction=0.25, scaled≈0.435, bucket=floor(0.435*7)=3
      const bucket = computeHeatmapBucket(daysAgo(7.5), WINDOW_30, NOW_MS);
      assert.ok(bucket >= 2 && bucket <= 3, `expected 2 or 3, got ${bucket}`);
    });

    test("bucket never exceeds HEATMAP_IN_WINDOW_BUCKETS-1 regardless of file age", () => {
      const ages = [0, 1, 5, 15, 30, 60, 365];
      for (const age of ages) {
        const bucket = computeHeatmapBucket(daysAgo(age), WINDOW_30, NOW_MS);
        assert.ok(
          bucket >= 0 && bucket < HEATMAP_IN_WINDOW_BUCKETS,
          `age=${age}d produced out-of-range bucket ${bucket}`
        );
      }
    });

    test("more recent file always gets a bucket <= older file's bucket", () => {
      const recent = computeHeatmapBucket(daysAgo(2), WINDOW_30, NOW_MS);
      const older = computeHeatmapBucket(daysAgo(20), WINDOW_30, NOW_MS);
      assert.ok(recent <= older, `recent bucket ${recent} should be <= older bucket ${older}`);
    });

    test("time window size does not affect the bucket count — only age fraction changes", () => {
      // A file at exactly 50% of a 7-day window and 50% of a 365-day window
      // should land in the same bucket because ageFraction is the same (0.5).
      const b7 = computeHeatmapBucket(daysAgo(3.5), 7, NOW_MS);
      const b365 = computeHeatmapBucket(daysAgo(182.5), 365, NOW_MS);
      assert.strictEqual(b7, b365);
    });
  });

  // ─── bucketToColorId ────────────────────────────────────────────────────

  suite("bucketToColorId", () => {
    test("bucket 0 → age1 (freshest color)", () => {
      assert.strictEqual(bucketToColorId(0), "freshFileExplorer.heatmap.age1");
    });

    test("bucket HEATMAP_BUCKET_COUNT-1 → age8 (oldest color)", () => {
      assert.strictEqual(
        bucketToColorId(HEATMAP_BUCKET_COUNT - 1),
        `freshFileExplorer.heatmap.age${HEATMAP_BUCKET_COUNT}`
      );
    });

    test("all 8 buckets produce distinct color IDs", () => {
      const ids = Array.from({ length: HEATMAP_BUCKET_COUNT }, (_, i) => bucketToColorId(i));
      const unique = new Set(ids);
      assert.strictEqual(unique.size, HEATMAP_BUCKET_COUNT);
    });
  });

  // ─── getBucketBoundaries ────────────────────────────────────────────────
  // Informational only — the exponential scale makes the bucket distribution
  // non-obvious. Run this test to see the actual day ranges for the windows
  // we ship with.

  suite("getBucketBoundaries", () => {
    test("prints bucket boundaries for common time windows", () => {
      const fmt = (days: number): string => {
        const h = days * 24;
        if (h < 1) { return `${(h * 60).toFixed(0)}m`; }
        if (h < 48) { return `${h.toFixed(1)}h`; }
        return `${days.toFixed(1)}d`;
      };

      for (const windowDays of [3, 7, 30, 90]) {
        console.log(`\nWindow: ${windowDays} days`);
        for (const b of getBucketBoundaries(windowDays)) {
          console.log(`  ${b.colorId.replace("freshFileExplorer.heatmap.", "")}: ${fmt(b.startDays)} – ${fmt(b.endDays)}`);
        }
      }
    });
  });

  // ─── computeHeatmapColorId ──────────────────────────────────────────────

  suite("computeHeatmapColorId", () => {
    test("brand-new file → age1", () => {
      assert.strictEqual(
        computeHeatmapColorId(new Date(NOW_MS), 30, NOW_MS),
        "freshFileExplorer.heatmap.age1"
      );
    });

    test("file at window edge → age7 (age8 is reserved for out-of-window files)", () => {
      assert.strictEqual(
        computeHeatmapColorId(daysAgo(30), 30, NOW_MS),
        "freshFileExplorer.heatmap.age7"
      );
    });

    test("file way beyond window edge → age7 (clamped, not age8 which is the out-of-window color)", () => {
      assert.strictEqual(
        computeHeatmapColorId(daysAgo(365), 30, NOW_MS),
        "freshFileExplorer.heatmap.age7"
      );
    });

    test("OUT_OF_WINDOW_COLOR_ID is age8 and distinct from any in-window color", () => {
      assert.strictEqual(OUT_OF_WINDOW_COLOR_ID, "freshFileExplorer.heatmap.age8");
      assert.notStrictEqual(computeHeatmapColorId(daysAgo(30), 30, NOW_MS), OUT_OF_WINDOW_COLOR_ID);
    });
  });
});
