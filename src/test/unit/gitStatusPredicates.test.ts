import * as assert from "assert";
import { suite, test } from "mocha";
import { hasStagedChanges, hasUnstagedChanges, isStagedOnly } from "../../git/gitOperations";

suite("git status predicates", () => {
  suite("hasStagedChanges", () => {
    // Staged-only (X != ' ', Y == ' ')
    test("\"M \" has staged changes", () => assert.strictEqual(hasStagedChanges("M "), true));
    test("\"A \" has staged changes", () => assert.strictEqual(hasStagedChanges("A "), true));
    test("\"D \" has staged changes", () => assert.strictEqual(hasStagedChanges("D "), true));
    test("\"R \" has staged changes", () => assert.strictEqual(hasStagedChanges("R "), true));

    // Both staged and unstaged (X != ' ', Y != ' ')
    test("\"MM\" has staged changes", () => assert.strictEqual(hasStagedChanges("MM"), true));
    test("\"AM\" has staged changes", () => assert.strictEqual(hasStagedChanges("AM"), true));
    test("\"MD\" has staged changes", () => assert.strictEqual(hasStagedChanges("MD"), true));
    test("\"RM\" has staged changes", () => assert.strictEqual(hasStagedChanges("RM"), true));

    // Unstaged-only (X == ' ', Y != ' ')
    test("\" M\" has no staged changes", () => assert.strictEqual(hasStagedChanges(" M"), false));
    test("\" D\" has no staged changes", () => assert.strictEqual(hasStagedChanges(" D"), false));

    // Special codes
    test("\"??\" has no staged changes", () => assert.strictEqual(hasStagedChanges("??"), false));
    test("\"!!\" has no staged changes", () => assert.strictEqual(hasStagedChanges("!!"), false));
  });

  suite("hasUnstagedChanges", () => {
    // Unstaged-only (X == ' ', Y != ' ')
    test("\" M\" has unstaged changes", () => assert.strictEqual(hasUnstagedChanges(" M"), true));
    test("\" D\" has unstaged changes", () => assert.strictEqual(hasUnstagedChanges(" D"), true));
    test("\" T\" has unstaged changes", () => assert.strictEqual(hasUnstagedChanges(" T"), true));

    // Both staged and unstaged (X != ' ', Y != ' ')
    test("\"MM\" has unstaged changes", () => assert.strictEqual(hasUnstagedChanges("MM"), true));
    test("\"AM\" has unstaged changes", () => assert.strictEqual(hasUnstagedChanges("AM"), true));
    test("\"MD\" has unstaged changes", () => assert.strictEqual(hasUnstagedChanges("MD"), true));

    // Staged-only (X != ' ', Y == ' ')
    test("\"M \" has no unstaged changes", () => assert.strictEqual(hasUnstagedChanges("M "), false));
    test("\"A \" has no unstaged changes", () => assert.strictEqual(hasUnstagedChanges("A "), false));
    test("\"D \" has no unstaged changes", () => assert.strictEqual(hasUnstagedChanges("D "), false));

    // Special codes
    test("\"??\" has no unstaged changes", () => assert.strictEqual(hasUnstagedChanges("??"), false));
    test("\"!!\" has no unstaged changes", () => assert.strictEqual(hasUnstagedChanges("!!"), false));
  });

  suite("isStagedOnly", () => {
    // Staged-only — the silent no-op cases for `git checkout -- <file>`
    test("\"M \" is staged only", () => assert.strictEqual(isStagedOnly("M "), true));
    test("\"A \" is staged only", () => assert.strictEqual(isStagedOnly("A "), true));
    test("\"D \" is staged only", () => assert.strictEqual(isStagedOnly("D "), true));
    test("\"R \" is staged only", () => assert.strictEqual(isStagedOnly("R "), true));

    // Both staged and unstaged — NOT staged only
    test("\"MM\" is not staged only", () => assert.strictEqual(isStagedOnly("MM"), false));
    test("\"AM\" is not staged only", () => assert.strictEqual(isStagedOnly("AM"), false));
    test("\"MD\" is not staged only", () => assert.strictEqual(isStagedOnly("MD"), false));

    // Unstaged-only — NOT staged only
    test("\" M\" is not staged only", () => assert.strictEqual(isStagedOnly(" M"), false));
    test("\" D\" is not staged only", () => assert.strictEqual(isStagedOnly(" D"), false));

    // Special codes
    test("\"??\" is not staged only", () => assert.strictEqual(isStagedOnly("??"), false));
    test("\"!!\" is not staged only", () => assert.strictEqual(isStagedOnly("!!"), false));
  });
});
