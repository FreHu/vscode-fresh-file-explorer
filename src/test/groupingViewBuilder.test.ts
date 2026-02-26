import * as assert from "assert";
import { GroupingViewBuilder } from "../fresh-files/groupingViewBuilder";
import { FileMetadata } from "../types";
import { AbsolutePath, asAbsolutePath } from "../pathTypes";

suite("GroupingViewBuilder", () => {
  suite("sortFilesList", () => {
    suite("date sorting", () => {
      test("should sort files by date (most recent first)", () => {
        const filesList = [
          {
            filePath: asAbsolutePath("/repo/old.ts"),
            metadata: { date: new Date("2024-01-01") } as FileMetadata,
          },
          {
            filePath: asAbsolutePath("/repo/newest.ts"),
            metadata: { date: new Date("2024-03-01") } as FileMetadata,
          },
          {
            filePath: asAbsolutePath("/repo/middle.ts"),
            metadata: { date: new Date("2024-02-01") } as FileMetadata,
          },
        ];

        GroupingViewBuilder.sortFilesList(filesList, "date");

        assert.strictEqual(filesList[0].filePath, "/repo/newest.ts");
        assert.strictEqual(filesList[1].filePath, "/repo/middle.ts");
        assert.strictEqual(filesList[2].filePath, "/repo/old.ts");
      });

      test("should handle same dates", () => {
        const filesList = [
          {
            filePath: asAbsolutePath("/repo/file1.ts"),
            metadata: { date: new Date("2024-01-01T12:00:00") } as FileMetadata,
          },
          {
            filePath: asAbsolutePath("/repo/file2.ts"),
            metadata: { date: new Date("2024-01-01T12:00:00") } as FileMetadata,
          },
        ];

        GroupingViewBuilder.sortFilesList(filesList, "date");

        assert.strictEqual(filesList.length, 2);
      });
    });

    suite("author sorting", () => {
      test("should sort files by author alphabetically", () => {
        const filesList = [
          {
            filePath: asAbsolutePath("/repo/charlie.ts"),
            metadata: { date: new Date(), author: "Charlie" as any } as FileMetadata,
          },
          {
            filePath: asAbsolutePath("/repo/alice.ts"),
            metadata: { date: new Date(), author: "Alice" as any } as FileMetadata,
          },
          {
            filePath: asAbsolutePath("/repo/bob.ts"),
            metadata: { date: new Date(), author: "Bob" as any } as FileMetadata,
          },
        ];

        GroupingViewBuilder.sortFilesList(filesList, "author");

        assert.strictEqual(filesList[0].metadata.author, "Alice");
        assert.strictEqual(filesList[1].metadata.author, "Bob");
        assert.strictEqual(filesList[2].metadata.author, "Charlie");
      });

      test("should use filename as tiebreaker when authors are the same", () => {
        const filesList = [
          {
            filePath: asAbsolutePath("/repo/zebra.ts"),
            metadata: { date: new Date(), author: "Alice" as any } as FileMetadata,
          },
          {
            filePath: asAbsolutePath("/repo/apple.ts"),
            metadata: { date: new Date(), author: "Alice" as any } as FileMetadata,
          },
          {
            filePath: asAbsolutePath("/repo/mango.ts"),
            metadata: { date: new Date(), author: "Alice" as any } as FileMetadata,
          },
        ];

        GroupingViewBuilder.sortFilesList(filesList, "author");

        assert.ok(filesList[0].filePath.includes("apple.ts"));
        assert.ok(filesList[1].filePath.includes("mango.ts"));
        assert.ok(filesList[2].filePath.includes("zebra.ts"));
      });

      test("should handle files without authors (empty string)", () => {
        const filesList = [
          {
            filePath: asAbsolutePath("/repo/file1.ts"),
            metadata: { date: new Date(), author: "Bob" as any } as FileMetadata,
          },
          {
            filePath: asAbsolutePath("/repo/file2.ts"),
            metadata: { date: new Date() } as FileMetadata,
          },
          {
            filePath: asAbsolutePath("/repo/file3.ts"),
            metadata: { date: new Date(), author: "Alice" as any } as FileMetadata,
          },
        ];

        GroupingViewBuilder.sortFilesList(filesList, "author");

        assert.ok(filesList[0].filePath.includes("file2.ts"));
        assert.strictEqual(filesList[1].metadata.author, "Alice");
        assert.strictEqual(filesList[2].metadata.author, "Bob");
      });
    });

    suite("name sorting", () => {
      test("should sort files alphabetically by filename", () => {
        const filesList = [
          {
            filePath: asAbsolutePath("/repo/zebra.ts"),
            metadata: { date: new Date() } as FileMetadata,
          },
          {
            filePath: asAbsolutePath("/repo/apple.ts"),
            metadata: { date: new Date() } as FileMetadata,
          },
          {
            filePath: asAbsolutePath("/repo/mango.ts"),
            metadata: { date: new Date() } as FileMetadata,
          },
        ];

        GroupingViewBuilder.sortFilesList(filesList, "name");

        assert.ok(filesList[0].filePath.includes("apple.ts"));
        assert.ok(filesList[1].filePath.includes("mango.ts"));
        assert.ok(filesList[2].filePath.includes("zebra.ts"));
      });

      test("should ignore directory path when sorting by name", () => {
        const filesList = [
          {
            filePath: asAbsolutePath("/repo/aaa/zebra.ts"),
            metadata: { date: new Date() } as FileMetadata,
          },
          {
            filePath: asAbsolutePath("/repo/zzz/apple.ts"),
            metadata: { date: new Date() } as FileMetadata,
          },
          {
            filePath: asAbsolutePath("/repo/mmm/mango.ts"),
            metadata: { date: new Date() } as FileMetadata,
          },
        ];

        GroupingViewBuilder.sortFilesList(filesList, "name");

        assert.ok(filesList[0].filePath.includes("apple.ts"));
        assert.ok(filesList[1].filePath.includes("mango.ts"));
        assert.ok(filesList[2].filePath.includes("zebra.ts"));
      });

      test("should handle case-insensitive sorting", () => {
        const filesList = [
          {
            filePath: asAbsolutePath("/repo/Zebra.ts"),
            metadata: { date: new Date() } as FileMetadata,
          },
          {
            filePath: asAbsolutePath("/repo/apple.ts"),
            metadata: { date: new Date() } as FileMetadata,
          },
          {
            filePath: asAbsolutePath("/repo/Mango.ts"),
            metadata: { date: new Date() } as FileMetadata,
          },
        ];

        GroupingViewBuilder.sortFilesList(filesList, "name");

        assert.ok(filesList[0].filePath.includes("apple.ts"));
        assert.ok(filesList[1].filePath.includes("Mango.ts"));
        assert.ok(filesList[2].filePath.includes("Zebra.ts"));
      });
    });

    suite("default sorting", () => {
      test("should default to name sorting when sort order is invalid", () => {
        const filesList = [
          {
            filePath: asAbsolutePath("/repo/zebra.ts"),
            metadata: { date: new Date() } as FileMetadata,
          },
          {
            filePath: asAbsolutePath("/repo/apple.ts"),
            metadata: { date: new Date() } as FileMetadata,
          },
        ];

        GroupingViewBuilder.sortFilesList(filesList, "invalid" as any);

        assert.ok(filesList[0].filePath.includes("apple.ts"));
        assert.ok(filesList[1].filePath.includes("zebra.ts"));
      });
    });

    suite("edge cases", () => {
      test("should handle empty array", () => {
        const filesList: Array<{ filePath: AbsolutePath; metadata: FileMetadata }> = [];
        GroupingViewBuilder.sortFilesList(filesList, "name");
        assert.strictEqual(filesList.length, 0);
      });

      test("should handle single item", () => {
        const filesList = [
          {
            filePath: asAbsolutePath("/repo/single.ts"),
            metadata: { date: new Date() } as FileMetadata,
          },
        ];
        GroupingViewBuilder.sortFilesList(filesList, "name");
        assert.strictEqual(filesList.length, 1);
        assert.ok(filesList[0].filePath.includes("single.ts"));
      });

      test("should sort in place (mutate array)", () => {
        const filesList = [
          {
            filePath: asAbsolutePath("/repo/b.ts"),
            metadata: { date: new Date() } as FileMetadata,
          },
          {
            filePath: asAbsolutePath("/repo/a.ts"),
            metadata: { date: new Date() } as FileMetadata,
          },
        ];
        const originalArray = filesList;

        GroupingViewBuilder.sortFilesList(filesList, "name");

        assert.strictEqual(filesList, originalArray);
        assert.ok(filesList[0].filePath.includes("a.ts"));
      });
    });
  });
});
