import * as assert from "assert";
import { changeLevel, shouldNotify } from "../../extension/versionGate";

// Pure logic — these don't touch the VS Code API, so they run as plain unit tests.

suite("versionGate.changeLevel", () => {
  test("detects the level of an upgrade", () => {
    assert.strictEqual(changeLevel("1.2.3", "1.2.4"), "patch");
    assert.strictEqual(changeLevel("1.2.3", "1.3.0"), "minor");
    assert.strictEqual(changeLevel("1.2.3", "2.0.0"), "major");
  });

  test("major bump wins even if minor/patch drop", () => {
    assert.strictEqual(changeLevel("1.9.9", "2.0.0"), "major");
  });

  test("same version, downgrade, and garbage are all null", () => {
    assert.strictEqual(changeLevel("1.2.3", "1.2.3"), null);
    assert.strictEqual(changeLevel("1.2.3", "1.2.2"), null);
    assert.strictEqual(changeLevel("1.2.3", "not-a-version"), null);
  });

  test("ignores prerelease / build suffixes", () => {
    assert.strictEqual(changeLevel("1.2.3", "1.2.4-beta.1"), "patch");
  });
});

suite("versionGate.shouldNotify", () => {
  test('threshold "patch" notifies on any bump', () => {
    assert.strictEqual(shouldNotify("1.2.3", "1.2.4", "patch"), true);
    assert.strictEqual(shouldNotify("1.2.3", "1.3.0", "patch"), true);
    assert.strictEqual(shouldNotify("1.2.3", "2.0.0", "patch"), true);
  });

  test('threshold "minor" (the default) skips patch bumps', () => {
    assert.strictEqual(shouldNotify("1.2.3", "1.2.4", "minor"), false);
    assert.strictEqual(shouldNotify("1.2.3", "1.3.0", "minor"), true);
    assert.strictEqual(shouldNotify("1.2.3", "2.0.0", "minor"), true);
  });

  test('threshold "major" only notifies on major bumps', () => {
    assert.strictEqual(shouldNotify("1.2.3", "1.3.0", "major"), false);
    assert.strictEqual(shouldNotify("1.2.3", "2.0.0", "major"), true);
  });

  test("never notifies on same version or downgrade", () => {
    assert.strictEqual(shouldNotify("1.2.3", "1.2.3", "minor"), false);
    assert.strictEqual(shouldNotify("2.0.0", "1.0.0", "minor"), false);
  });
});
