import { expect } from "chai";
import {
  formatRepoDescription,
  formatRepoTooltip,
  formatDirectoryTooltip,
  formatRelativeDate
} from "../../utils/formatUtils";

describe("Format Utils", () => {
  describe("formatRepoDescription", () => {
    it("should format with branch name and file count", () => {
      expect(formatRepoDescription("main", 5)).to.equal("🔀 main");
    });

    it("should format without branch name", () => {
      expect(formatRepoDescription(undefined, 5)).to.equal("(5)");
    });

    it("should show no files message with branch", () => {
      expect(formatRepoDescription("main", 0)).to.equal("🔀 main (no fresh files)");
    });

    it("should show no files message without branch", () => {
      expect(formatRepoDescription(undefined, 0)).to.equal("(no fresh files)");
    });
  });

  describe("formatRepoTooltip", () => {
    it("should format tooltip with branch name", () => {
      const result = formatRepoTooltip("my-project", "main", 10);
      expect(result).to.equal("my-project (main)\n10 file(s) modified");
    });

    it("should format tooltip without branch name", () => {
      const result = formatRepoTooltip("my-project", undefined, 5);
      expect(result).to.equal("my-project\n5 file(s) modified");
    });

    it("should handle singular file count", () => {
      const result = formatRepoTooltip("my-project", "main", 1);
      expect(result).to.equal("my-project (main)\n1 file(s) modified");
    });
  });

  describe("formatDirectoryTooltip", () => {
    it("should format directory tooltip with count and date", () => {
      const date = new Date("2026-01-28T12:00:00");
      const result = formatDirectoryTooltip(5, date);
      expect(result).to.match(/5 file\(s\) modified, most recent: .+/);
    });

    it("should handle singular file count", () => {
      const date = new Date("2026-01-28T12:00:00");
      const result = formatDirectoryTooltip(1, date);
      expect(result).to.match(/1 file\(s\) modified, most recent: .+/);
    });
  });

  describe("formatRelativeDate", () => {
    const now = new Date("2026-01-28T12:00:00");
    
    // Helper to create a date relative to 'now'
    const minutesAgo = (m: number) => new Date(now.getTime() - m * 60 * 1000);
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000);
    const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);

    beforeEach(() => {
      // Mock Date.now() to return our test date
      const originalDate = Date;
      (global as any).Date = class extends originalDate {
        constructor(...args: [] | [string | number | Date]) {
          if (args.length === 0) {
            super(now.getTime());
          } else {
            super(args[0]);
          }
        }
        static now() {
          return now.getTime();
        }
      };
    });

    afterEach(() => {
      // Restore original Date
      (global as any).Date = Date;
    });

    it("should format very recent times as 'just now'", () => {
      expect(formatRelativeDate(minutesAgo(0))).to.equal("just now");
      expect(formatRelativeDate(minutesAgo(1))).to.equal("just now");
    });

    it("should format minutes ago", () => {
      expect(formatRelativeDate(minutesAgo(5))).to.equal("5 minutes ago");
      expect(formatRelativeDate(minutesAgo(30))).to.equal("30 minutes ago");
      expect(formatRelativeDate(minutesAgo(59))).to.equal("59 minutes ago");
    });

    it("should format hours ago", () => {
      expect(formatRelativeDate(hoursAgo(1))).to.equal("1 hour ago");
      expect(formatRelativeDate(hoursAgo(5))).to.equal("5 hours ago");
      expect(formatRelativeDate(hoursAgo(23))).to.equal("23 hours ago");
    });

    it("should format days ago", () => {
      expect(formatRelativeDate(daysAgo(1))).to.equal("yesterday");
      expect(formatRelativeDate(daysAgo(2))).to.equal("2 days ago");
      expect(formatRelativeDate(daysAgo(6))).to.equal("6 days ago");
    });

    it("should format weeks ago", () => {
      expect(formatRelativeDate(daysAgo(7))).to.equal("1 week ago");
      expect(formatRelativeDate(daysAgo(14))).to.equal("2 weeks ago");
      expect(formatRelativeDate(daysAgo(21))).to.equal("3 weeks ago");
    });

    it("should format months ago", () => {
      expect(formatRelativeDate(daysAgo(30))).to.equal("1 month ago");
      expect(formatRelativeDate(daysAgo(60))).to.equal("2 months ago");
    });
  });
});
