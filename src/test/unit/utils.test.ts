import { expect } from "chai";
import { normalizePath, formatDaysLabel, setDifference, dotsDots } from "../../utils";

describe("Utils", () => {
  describe("normalizePath", () => {
    it("should convert backslashes to forward slashes", () => {
      expect(normalizePath("C:\\Users\\test\\file.txt")).to.equal("C:/Users/test/file.txt");
    });

    it("should handle paths with mixed separators", () => {
      expect(normalizePath("C:\\Users/test\\file.txt")).to.equal("C:/Users/test/file.txt");
    });

    it("should leave forward slashes unchanged", () => {
      expect(normalizePath("/home/user/file.txt")).to.equal("/home/user/file.txt");
    });

    it("should handle empty string", () => {
      expect(normalizePath("")).to.equal("");
    });

    it("should handle UNC paths", () => {
      expect(normalizePath("\\\\server\\share\\file.txt")).to.equal("//server/share/file.txt");
    });
  });

  describe("formatDaysLabel", () => {
    it("should format pending changes label", () => {
      expect(formatDaysLabel(-1)).to.equal("Pending changes");
    });

    it("should format single day", () => {
      expect(formatDaysLabel(1)).to.equal("1 day");
    });

    it("should format weeks", () => {
      expect(formatDaysLabel(7)).to.equal("1 week");
      expect(formatDaysLabel(14)).to.equal("2 weeks");
    });

    it("should format months", () => {
      expect(formatDaysLabel(30)).to.equal("1 month");
      expect(formatDaysLabel(60)).to.equal("2 months");
      expect(formatDaysLabel(90)).to.equal("3 months");
      expect(formatDaysLabel(180)).to.equal("6 months");
    });

    it("should format year", () => {
      expect(formatDaysLabel(365)).to.equal("1 year");
    });

    it("should format custom day counts", () => {
      expect(formatDaysLabel(5)).to.equal("5 days");
      expect(formatDaysLabel(100)).to.equal("100 days");
    });
  });

  describe("setDifference", () => {
    it("should return elements in first set not in second", () => {
      const all = new Set([1, 2, 3, 4, 5]);
      const exclude = new Set([2, 4]);
      const result = setDifference(all, exclude);
      expect(result).to.deep.equal(new Set([1, 3, 5]));
    });

    it("should handle empty exclude set", () => {
      const all = new Set([1, 2, 3]);
      const exclude = new Set<number>([]);
      const result = setDifference(all, exclude);
      expect(result).to.deep.equal(new Set([1, 2, 3]));
    });

    it("should handle exclude with no overlaps", () => {
      const all = new Set([1, 2, 3]);
      const exclude = new Set([4, 5, 6]);
      const result = setDifference(all, exclude);
      expect(result).to.deep.equal(new Set([1, 2, 3]));
    });

    it("should handle complete overlap", () => {
      const all = new Set([1, 2, 3]);
      const exclude = new Set([1, 2, 3]);
      const result = setDifference(all, exclude);
      expect(result).to.deep.equal(new Set([]));
    });

    it("should work with arrays as input", () => {
      const all = [1, 2, 3, 4, 5];
      const exclude = new Set([2, 4]);
      const result = setDifference(all, exclude);
      expect(result).to.deep.equal(new Set([1, 3, 5]));
    });
  });

  describe("dotsDots", () => {
    it("should truncate strings longer than the specified length", () => {
      const longString = "a".repeat(100);
      expect(dotsDots(longString, 80)).to.equal("a".repeat(77) + "...");
    });

    it("should not truncate strings shorter than the length", () => {
      const shortString = "hello world";
      expect(dotsDots(shortString, 80)).to.equal("hello world");
    });

    it("should handle exact length strings", () => {
      const exactString = "a".repeat(80);
      expect(dotsDots(exactString, 80)).to.equal("a".repeat(80));
    });

    it("should use default length of 80", () => {
      const longString = "a".repeat(100);
      expect(dotsDots(longString)).to.equal("a".repeat(77) + "...");
    });

    it("should handle empty strings", () => {
      expect(dotsDots("", 80)).to.equal("");
    });

    it("should handle custom lengths", () => {
      const string = "hello world this is a long string";
      expect(dotsDots(string, 10)).to.equal("hello w...");
    });
  });
});
