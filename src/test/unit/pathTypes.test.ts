import { expect } from "chai";
import { isAbsolutePath, asAbsolutePath, asRelativePath } from "../../pathTypes";

describe("Path Types", () => {
  describe("isAbsolutePath", () => {
    it("should recognize Windows absolute paths with drive letters", () => {
      expect(isAbsolutePath("C:\\Users\\test")).to.be.true;
      expect(isAbsolutePath("D:/Projects/file.txt")).to.be.true;
      expect(isAbsolutePath("c:\\temp")).to.be.true;
    });

    it("should recognize UNC paths", () => {
      expect(isAbsolutePath("\\\\server\\share\\file")).to.be.true;
      expect(isAbsolutePath("//server/share/file")).to.be.true;
    });

    it("should recognize Unix absolute paths", () => {
      expect(isAbsolutePath("/home/user/file.txt")).to.be.true;
      expect(isAbsolutePath("/var/log")).to.be.true;
    });

    it("should reject relative paths", () => {
      expect(isAbsolutePath("src/test/file.txt")).to.be.false;
      expect(isAbsolutePath("./file.txt")).to.be.false;
      expect(isAbsolutePath("../parent/file.txt")).to.be.false;
      expect(isAbsolutePath("file.txt")).to.be.false;
    });

    it("should handle empty string", () => {
      expect(isAbsolutePath("")).to.be.false;
    });
  });

  describe("asAbsolutePath", () => {
    it("should normalize Windows paths to forward slashes", () => {
      const result = asAbsolutePath("C:\\Users\\test\\file.txt");
      expect(result).to.equal("C:/Users/test/file.txt");
    });

    it("should normalize mixed separator paths", () => {
      const result = asAbsolutePath("C:\\Users/test\\file.txt");
      expect(result).to.equal("C:/Users/test/file.txt");
    });

    it("should preserve Unix paths with forward slashes", () => {
      const result = asAbsolutePath("/home/user/file.txt");
      expect(result).to.equal("/home/user/file.txt");
    });

    it("should handle UNC paths", () => {
      const result = asAbsolutePath("\\\\server\\share\\file.txt");
      expect(result).to.equal("//server/share/file.txt");
    });
  });

  describe("asRelativePath", () => {
    it("should cast string to RelativePath", () => {
      const result = asRelativePath("src/test/file.txt");
      expect(result).to.equal("src/test/file.txt");
    });

    it("should handle paths with forward slashes", () => {
      const result = asRelativePath("./src/file.txt");
      expect(result).to.equal("./src/file.txt");
    });

    it("should handle paths with backslashes", () => {
      const result = asRelativePath("src\\test\\file.txt");
      expect(result).to.equal("src\\test\\file.txt");
    });

    it("should handle empty string", () => {
      const result = asRelativePath("");
      expect(result).to.equal("");
    });
  });
});
