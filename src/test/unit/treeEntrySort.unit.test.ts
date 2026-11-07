import * as assert from "assert";
import { sortTreeEntries, TreeEntryAccessors } from "../../utils/treeEntrySort";

interface Entry { name: string; dir?: boolean; date?: number; author?: string }

const get: TreeEntryAccessors<Entry> = {
  name: e => e.name,
  isDirectory: e => e.dir ?? false,
  date: e => e.date === undefined ? undefined : new Date(e.date),
  author: e => e.author ?? "",
};

function sorted(entries: Entry[], order: "name" | "date" | "author"): string[] {
  const copy = [...entries];
  sortTreeEntries(copy, order, get);
  return copy.map(e => e.name);
}

suite("sortTreeEntries", () => {
  const entries: Entry[] = [
    { name: "b.ts", date: 300, author: "Zoe" },
    { name: "src", dir: true, date: 400 },
    { name: "a.ts", date: 100, author: "Adam" },
    { name: "docs", dir: true, date: 200 },
  ];

  test("name: folders first, each alphabetical", () => {
    assert.deepStrictEqual(sorted(entries, "name"), ["docs", "src", "a.ts", "b.ts"]);
  });

  test("date: folders and files mixed, newest first", () => {
    assert.deepStrictEqual(sorted(entries, "date"), ["src", "b.ts", "docs", "a.ts"]);
  });

  test("author: folders first by name, files by author", () => {
    assert.deepStrictEqual(sorted(entries, "author"), ["docs", "src", "a.ts", "b.ts"]);
  });

  test("date: equal dates and missing dates break ties by name, missing last", () => {
    const tied: Entry[] = [
      { name: "z.ts" }, { name: "c.ts", date: 5 }, { name: "b.ts", date: 5 }, { name: "a.ts" },
    ];
    assert.deepStrictEqual(sorted(tied, "date"), ["b.ts", "c.ts", "a.ts", "z.ts"]);
  });
});
