import * as assert from "assert";
import { isAbsolutePath, asAbsolutePath, asRelativePath } from "../../pathTypes";

suite("Path Types", () => {
  suite("isAbsolutePath", () => {
    test("should recognize Windows absolute paths with drive letters", () => {
      assert.strictEqual(isAbsolutePath("C:\\Users\\test"), true);
      assert.strictEqual(isAbsolutePath("D:/Projects/file.txt"), true);
      assert.strictEqual(isAbsolutePath("c:\\temp"), true);
    });

    test("should recognize UNC paths", () => {
      assert.strictEqual(isAbsolutePath("\\\\server\\share\\file"), true);
      assert.strictEqual(isAbsolutePath("//server/share/file"), true);
    });

    test("should recognize Unix absolute paths", () => {
      assert.strictEqual(isAbsolutePath("/home/user/file.txt"), true);
      assert.strictEqual(isAbsolutePath("/var/log"), true);
    });

    test("should reject relative paths", () => {
      assert.strictEqual(isAbsolutePath("src/test/file.txt"), false);
      assert.strictEqual(isAbsolutePath("./file.txt"), false);
      assert.strictEqual(isAbsolutePath("../parent/file.txt"), false);
      assert.strictEqual(isAbsolutePath("file.txt"), false);
    });

    test("should handle empty string", () => {
      assert.strictEqual(isAbsolutePath(""), false);
    });
  });

  suite("asAbsolutePath", () => {
    test("should normalize Windows paths to forward slashes", () => {
      const result = asAbsolutePath("C:\\Users\\test\\file.txt");
      assert.strictEqual(result, "C:/Users/test/file.txt");
    });

    test("should normalize mixed separator paths", () => {
      const result = asAbsolutePath("C:\\Users/test\\file.txt");
      assert.strictEqual(result, "C:/Users/test/file.txt");
    });

    test("should preserve Unix paths with forward slashes", () => {
      const result = asAbsolutePath("/home/user/file.txt");
      assert.strictEqual(result, "/home/user/file.txt");
    });

    test("should handle UNC paths", () => {
      const result = asAbsolutePath("\\\\server\\share\\file.txt");
      assert.strictEqual(result, "//server/share/file.txt");
    });
  });

  suite("asRelativePath", () => {
    test("should cast string to RelativePath", () => {
      const result = asRelativePath("src/test/file.txt");
      assert.strictEqual(result, "src/test/file.txt");
    });

    test("should handle paths with forward slashes", () => {
      const result = asRelativePath("./src/file.txt");
      assert.strictEqual(result, "./src/file.txt");
    });

    test("should handle paths with backslashes", () => {
      const result = asRelativePath("src\\test\\file.txt");
      assert.strictEqual(result, "src\\test\\file.txt");
    });

    test("should handle empty string", () => {
      const result = asRelativePath("");
      assert.strictEqual(result, "");
    });
  });
});
