import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { OutlineHeading } from "../../fresh-files/outline/headingTree";
import { parseOrgHeadings } from "../../fresh-files/outline/orgHeadings";
import { parseAsciidocHeadings } from "../../fresh-files/outline/asciidocHeadings";
import { parseMarkdownHeadings } from "../../fresh-files/outline/markdownHeadings";
import { outlineFormatFor } from "../../fresh-files/outline/documentOutline";

// Fixtures are copied from src/test/fixtures/ into out/test/fixtures/ by `npm run copy:fixtures`.
// Each fixture's opening lines state what it should produce, for testing by hand too.
const fixture = (dir: string, name: string): string =>
  fs.readFileSync(path.join(__dirname, "..", "fixtures", dir, name), "utf-8");

/** Compact shape: `text` (with `[tag]` when set) for a leaf, `[text, ...children]` otherwise. */
type Shape = string | [string, ...Shape[]];
function shape(nodes: OutlineHeading[]): Shape[] {
  return nodes.map(n => {
    const label = n.tag ? `${n.text} [${n.tag}]` : n.text;
    return n.children.length ? [label, ...shape(n.children)] as Shape : label;
  });
}

suite("parseOrgHeadings", () => {
  test("stars nest; TODO / DONE become tags; priority and trailing tags are stripped", () => {
    assert.deepStrictEqual(shape(parseOrgHeadings(fixture("outline-org", "tasks.org"), 6)), [
      ["Project plan [TODO]",
        "Set up the repo [DONE]",
        ["Write the parser [TODO]", "Notes"],
        "Ship"],
      ["Someday", "Learn Emacs"],
    ]);
  });

  test("block contents, emphasis and indented stars are not headings", () => {
    assert.deepStrictEqual(shape(parseOrgHeadings(fixture("outline-org", "blocks.org"), 6)), [
      ["Real heading", "After the blocks"],
    ]);
  });

  test("#+TODO keywords replace the defaults; links keep their description", () => {
    assert.deepStrictEqual(shape(parseOrgHeadings(fixture("outline-org", "custom-keywords.org"), 6)), [
      ["Plan trip [NEXT]", "Book hotel [WAITING]", "Buy tickets [FINISHED]"],
      "Old idea [CANCELLED]",
      "TODO is text",
      "Read the docs",
    ]);
  });

  test("max depth applies; a bare keyword heading keeps the keyword as its text", () => {
    assert.deepStrictEqual(shape(parseOrgHeadings(fixture("outline-org", "tasks.org"), 1)), ["Project plan [TODO]", "Someday"]);
    assert.deepStrictEqual(shape(parseOrgHeadings("* TODO\n", 6)), ["TODO"]);
  });
});

suite("parseAsciidocHeadings", () => {
  test("document title, sections and symmetric closing marks", () => {
    assert.deepStrictEqual(shape(parseAsciidocHeadings(fixture("outline-adoc", "guide.adoc"), 6)), [
      ["User Guide", ["Install", "On Windows"], ["Configure", "Advanced"]],
    ]);
  });

  test("delimited blocks, comments and block titles are not sections", () => {
    assert.deepStrictEqual(shape(parseAsciidocHeadings(fixture("outline-adoc", "blocks.adoc"), 6)), [
      ["Blocks", "Real section", "After the blocks"],
    ]);
  });

  test("Markdown-style titles and inline markup", () => {
    assert.deepStrictEqual(shape(parseAsciidocHeadings(fixture("outline-adoc", "markdown-style.adoc"), 6)), [
      ["Title", "Section", "Bold and code", "Link text", "Cross ref"],
    ]);
  });

  test("underscores inside words survive", () => {
    assert.deepStrictEqual(shape(parseAsciidocHeadings("== Set my_var_name\n", 6)), ["Set my_var_name"]);
  });
});

suite("outlineFormatFor", () => {
  test("picks the parser by extension, case-insensitively", () => {
    assert.strictEqual(outlineFormatFor("/notes/todo.md"), "markdown");
    assert.strictEqual(outlineFormatFor("C:\\work\\Report.QMD"), "markdown");
    assert.strictEqual(outlineFormatFor("/a/analysis.Rmd"), "markdown");
    assert.strictEqual(outlineFormatFor("/a/page.mdx"), "markdown");
    assert.strictEqual(outlineFormatFor("/a/plan.org"), "org");
    assert.strictEqual(outlineFormatFor("/a/guide.adoc"), "asciidoc");
  });

  test("other files have no outline", () => {
    for (const p of ["/a/code.ts", "/a/README", "/a/.md.bak", "/a/notes.txt", "/a.org/file"]) {
      assert.strictEqual(outlineFormatFor(p), undefined, p);
    }
  });
});

suite("Markdown variants", () => {
  test("Quarto: front matter skipped, # comments in code chunks are not headings", () => {
    assert.deepStrictEqual(shape(parseMarkdownHeadings(fixture("outline-markdown-variants", "analysis.qmd"), 6)), [
      ["Load data", "Clean"],
      "Results",
    ]);
  });

  test("MDX: imports, exports and JSX don't disturb headings", () => {
    assert.deepStrictEqual(shape(parseMarkdownHeadings(fixture("outline-markdown-variants", "page.mdx"), 6)), [
      ["Page", "Chart section"],
    ]);
  });
});
