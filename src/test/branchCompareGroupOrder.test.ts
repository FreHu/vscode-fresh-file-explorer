import * as assert from "assert";
import { buildGroupedItems } from "../branch-compare/branchCompareGroupingBuilder";
import { ChangedFile } from "../branch-compare/branchCompareData";
import { getMoonPhase, MOON_PHASE_ORDER } from "../fresh-files/moonPhase";
import { AbsolutePath } from "../pathTypes";
import { CommitAuthor, CommitHash, CommitMessage } from "../types";

function fileAt(daysAgo: number): ChangedFile {
  const date = new Date(Date.UTC(2026, 10, 1) - daysAgo * 86_400_000);
  return {
    repoFullPath: "/repo" as AbsolutePath,
    pathInRepo: `f${daysAgo}.ts`,
    absolutePath: `/repo/f${daysAgo}.ts` as AbsolutePath,
    status: "M",
    isPending: false,
    commit: {
      hash: `h${daysAgo}` as CommitHash,
      message: "m" as CommitMessage,
      author: "a" as CommitAuthor,
      date,
    },
  } as ChangedFile;
}

const FORMAT = { showAuthor: false, showDate: false, showCommitMessage: false };

function byAuthor(file: ChangedFile, author: string): ChangedFile {
  return { ...file, commit: { ...file.commit!, author: author as CommitAuthor } };
}

suite("Branch Compare group order", () => {
  test("Moon Phase groups follow the lunar cycle, not recency", () => {
    // One file per day over a full cycle covers every phase, newest first.
    const files = Array.from({ length: 30 }, (_, i) => fileAt(i));
    const items = buildGroupedItems("c", "/repo", files, "Moon Phase", "date", FORMAT);

    const present = new Set(files.map(f => getMoonPhase(f.commit!.date).name));
    assert.deepStrictEqual(
      items.map(i => i.groupKey),
      MOON_PHASE_ORDER.filter(p => present.has(p)),
    );
  });

  test("Author groups are alphabetical, or most recent first when sorting by date", () => {
    const files = [byAuthor(fileAt(5), "Adam"), byAuthor(fileAt(1), "Zoe")];
    const keys = (order: "name" | "date" | "author") =>
      buildGroupedItems("c", "/repo", files, "Author", order, FORMAT).map(i => i.groupKey);

    assert.deepStrictEqual(keys("name"), ["Adam", "Zoe"]);
    assert.deepStrictEqual(keys("author"), ["Adam", "Zoe"]);
    assert.deepStrictEqual(keys("date"), ["Zoe", "Adam"]);
  });
});
