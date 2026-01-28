import { expect } from "chai";
import {
  isPendingChangesMode,
  buildTimeWindows,
  DEFAULT_TIME_WINDOW_DAYS,
  type TimeWindow
} from "../../timeWindowUtils";

describe("Time Window Utils", () => {
  describe("isPendingChangesMode", () => {
    it("should return true for pending time window", () => {
      const pendingWindow: TimeWindow = { type: "pending", label: "Pending changes" };
      expect(isPendingChangesMode(pendingWindow)).to.be.true;
    });

    it("should return false for historical time window", () => {
      const historicalWindow: TimeWindow = { type: "historical", label: "1 week", days: 7 };
      expect(isPendingChangesMode(historicalWindow)).to.be.false;
    });
  });

  describe("buildTimeWindows", () => {
    it("should always include pending changes as first item", () => {
      const windows = buildTimeWindows([7, 14]);
      expect(windows[0]).to.deep.equal({ type: "pending", label: "Pending changes" });
    });

    it("should sort day values in ascending order", () => {
      const windows = buildTimeWindows([30, 7, 14, 1]);
      expect(windows).to.have.lengthOf(5); // pending + 4 day values
      expect(windows[1]).to.deep.equal({ type: "historical", label: "1 day", days: 1 });
      expect(windows[2]).to.deep.equal({ type: "historical", label: "1 week", days: 7 });
      expect(windows[3]).to.deep.equal({ type: "historical", label: "2 weeks", days: 14 });
      expect(windows[4]).to.deep.equal({ type: "historical", label: "1 month", days: 30 });
    });

    it("should filter out non-positive values", () => {
      const windows = buildTimeWindows([7, 0, -5, 14]);
      expect(windows).to.have.lengthOf(3); // pending + 2 positive values
      expect(windows.some(w => w.type === "historical" && w.days <= 0)).to.be.false;
    });

    it("should handle empty input", () => {
      const windows = buildTimeWindows([]);
      expect(windows).to.deep.equal([{ type: "pending", label: "Pending changes" }]);
    });

    it("should handle single day value", () => {
      const windows = buildTimeWindows([7]);
      expect(windows).to.have.lengthOf(2);
      expect(windows[0]).to.deep.equal({ type: "pending", label: "Pending changes" });
      expect(windows[1]).to.deep.equal({ type: "historical", label: "1 week", days: 7 });
    });

    it("should use formatDaysLabel for custom labels", () => {
      const windows = buildTimeWindows([1, 7, 30, 365]);
      expect(windows[1]).to.deep.equal({ type: "historical", label: "1 day", days: 1 });
      expect(windows[2]).to.deep.equal({ type: "historical", label: "1 week", days: 7 });
      expect(windows[3]).to.deep.equal({ type: "historical", label: "1 month", days: 30 });
      expect(windows[4]).to.deep.equal({ type: "historical", label: "1 year", days: 365 });
    });

    it("should handle duplicate day values", () => {
      const windows = buildTimeWindows([7, 7, 14]);
      // Should sort but not deduplicate
      expect(windows).to.have.lengthOf(4); // pending + 3 values
    });

    it("should work with DEFAULT_TIME_WINDOW_DAYS", () => {
      const windows = buildTimeWindows(DEFAULT_TIME_WINDOW_DAYS);
      expect(windows).to.have.lengthOf(DEFAULT_TIME_WINDOW_DAYS.length + 1);
      expect(windows[0].type).to.equal("pending");
      // Verify all are historical after the first
      for (let i = 1; i < windows.length; i++) {
        expect(windows[i].type).to.equal("historical");
      }
    });
  });

  describe("DEFAULT_TIME_WINDOW_DAYS", () => {
    it("should be an array of positive integers", () => {
      expect(DEFAULT_TIME_WINDOW_DAYS).to.be.an("array");
      expect(DEFAULT_TIME_WINDOW_DAYS.every(d => d > 0)).to.be.true;
    });

    it("should contain expected default values", () => {
      expect(DEFAULT_TIME_WINDOW_DAYS).to.include(1);
      expect(DEFAULT_TIME_WINDOW_DAYS).to.include(7);
      expect(DEFAULT_TIME_WINDOW_DAYS).to.include(30);
    });
  });
});
