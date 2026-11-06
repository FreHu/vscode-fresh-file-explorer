import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { parseStatusZ, STATUS_Z_ARGS } from "../../git/statusPorcelainZ";
import { createTempRepo, TempGitRepo } from "../helpers/tempGitRepo";

suite("parseStatusZ", () => {
  test("keeps the raw XY code and both sides of a rename", () => {
    assert.deepStrictEqual(parseStatusZ("R  dir/new name.txt\0dir/old name.txt\0 M a.ts\0?? b.ts\0"), [
      { xy: "R ", pathInRepo: "dir/new name.txt", renameSource: "dir/old name.txt" },
      { xy: " M", pathInRepo: "a.ts" },
      { xy: "??", pathInRepo: "b.ts" },
    ]);
  });

  test("consumes a copy's source and drops ignored entries", () => {
    assert.deepStrictEqual(parseStatusZ("C  b.ts\0a.ts\0!! out.js\0MM c.ts\0"), [
      { xy: "C ", pathInRepo: "b.ts", renameSource: "a.ts" },
      { xy: "MM", pathInRepo: "c.ts" },
    ]);
  });

  test("empty output", () => {
    assert.deepStrictEqual(parseStatusZ(""), []);
  });
});

suite("parseStatusZ against real git", () => {
  let repo: TempGitRepo;

  suiteSetup(() => {
    repo = createTempRepo("ffe-status-z-");
    fs.mkdirSync(path.join(repo.dir, "dir"));
    fs.writeFileSync(path.join(repo.dir, "dir", "old name.txt"), "one\ntwo\nthree\n");
    fs.writeFileSync(path.join(repo.dir, "plain.txt"), "x\n");
    repo.git("add", "-A");
    repo.git("commit", "-qm", "first");
  });

  suiteTeardown(() => repo.dispose());

  test("a rename with spaces and non-ASCII characters keeps both paths verbatim", () => {
    repo.git("mv", "dir/old name.txt", "dir/nové jméno.txt");
    fs.writeFileSync(path.join(repo.dir, "plain.txt"), "y\n");
    // core.quotePath on and a hostile status format must not change -z output.
    const out = repo.git("-c", "core.quotePath=true", "-c", "status.short=false", ...STATUS_Z_ARGS);
    assert.deepStrictEqual(parseStatusZ(out), [
      { xy: "R ", pathInRepo: "dir/nové jméno.txt", renameSource: "dir/old name.txt" },
      { xy: " M", pathInRepo: "plain.txt" },
    ]);
  });
});
