import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

import { collectCochangeHistory } from "../cochange/cochangeHistory";
import { createTempRepo, TempGitRepo } from "./helpers/tempGitRepo";

/**
 * The collector's message/file disambiguation against real git output —
 * multi-line bodies and `--name-only` file lists share the same stream, so
 * the parse is the risky part, not the git invocation.
 */
suite("cochange history collector", () => {
  let repo: TempGitRepo;
  let tmpDir: string;

  suiteSetup(() => {
    repo = createTempRepo("ffe-cochange-");
    tmpDir = repo.dir;
    const git = repo.git;

    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "src", "a.ts"), "a");
    fs.writeFileSync(path.join(tmpDir, "src", "b.ts"), "b");
    git("add", ".");
    // Ticket reference in the BODY only, plus a body line that looks like a file path.
    git("commit", "-q", "-m", "add the widget",
      "-m", "Long explanation across lines.\nsrc/looks-like-a-path.ts is mentioned here.\nhttps://app.clickup.com/t/1234/863aaabbb");

    fs.writeFileSync(path.join(tmpDir, "src", "a.ts"), "a2");
    git("add", ".");
    git("commit", "-q", "-m", "AB-77 tweak the widget"); // subject-only reference, no body
  });

  suiteTeardown(() => repo.dispose());

  test("captures subject and body as the message, files as files", async () => {
    const commits = await collectCochangeHistory(tmpDir, 365);

    assert.strictEqual(commits.length, 2);
    const [tweak, add] = commits; // git log is newest-first

    assert.ok(tweak.message?.includes("AB-77 tweak the widget"));
    assert.deepStrictEqual(tweak.files, ["src/a.ts"]);

    assert.ok(add.message?.includes("add the widget"), "subject captured");
    assert.ok(add.message?.includes("863aaabbb"), "body ticket reference captured");
    assert.deepStrictEqual(add.files.sort(), ["src/a.ts", "src/b.ts"],
      "body lines that look like paths must not leak into the file list");
    assert.ok(typeof add.at === "number" && add.at > 0, "timestamp captured");
  });
});
