import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { MarkdownHeading, parseMarkdownHeadings } from "../../fresh-files/markdownHeadings";

// Fixtures are copied from src/test/fixtures/ into out/test/fixtures/ by `npm run copy:fixtures`.
// Each fixture's opening lines state what it should produce, for testing by hand too.
const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, "..", "fixtures", "markdown-headings", name), "utf-8");

/** Compact shape: `text` for a leaf, `[text, ...children]` otherwise. */
type Shape = string | [string, ...Shape[]];
function shape(nodes: MarkdownHeading[]): Shape[] {
  return nodes.map(n => (n.children.length ? [n.text, ...shape(n.children)] as Shape : n.text));
}

suite("parseMarkdownHeadings", () => {
  test("well-formed document nests by level", () => {
    assert.deepStrictEqual(shape(parseMarkdownHeadings(fixture("well-formed.md"), 6)), [
      ["Project plan",
        ["Phase 1", "Set up the repo", "Write the parser"],
        "Phase 2",
        ["Phase 3", ["Ship it", "Announce"]]],
    ]);
  });

  test("skipped levels nest under the nearest shallower heading", () => {
    assert.deepStrictEqual(shape(parseMarkdownHeadings(fixture("skipped-levels.md"), 6)), [
      ["Root", "Deep child", ["Back to h2", "Sibling h3"]],
    ]);
  });

  test("a document may start below h1", () => {
    assert.deepStrictEqual(shape(parseMarkdownHeadings(fixture("no-h1.md"), 6)), [
      "Starts deep",
      "Also deep",
      ["Shallower later", "Child of the h2"],
    ]);
  });

  test("code fences, nested fences and indented code are not headings", () => {
    assert.deepStrictEqual(shape(parseMarkdownHeadings(fixture("code-fences.md"), 6)), [
      ["Real heading", "After the fences"],
    ]);
  });

  test("an unclosed fence swallows the rest, as VS Code's outline does", () => {
    assert.deepStrictEqual(shape(parseMarkdownHeadings(fixture("unclosed-fence.md"), 6)), ["Before the fence"]);
  });

  test("setext headings; a rule after a blank line is not one", () => {
    assert.deepStrictEqual(shape(parseMarkdownHeadings(fixture("setext.md"), 6)), [
      ["Setext title", "Setext section", "ATX mixed in"],
    ]);
  });

  test("YAML front matter is skipped", () => {
    assert.deepStrictEqual(shape(parseMarkdownHeadings(fixture("front-matter.md"), 6)), [
      ["After front matter", "Child"],
    ]);
  });

  test("messy headings: closing hashes, inline markup, invalid forms skipped", () => {
    assert.deepStrictEqual(shape(parseMarkdownHeadings(fixture("messy.md"), 6)), [
      ["Closing hashes", "Bold and code", "Link text", "Duplicate", "Duplicate", "Tabs after hashes"],
    ]);
  });

  test("max depth drops deeper headings", () => {
    assert.deepStrictEqual(shape(parseMarkdownHeadings(fixture("deep.md"), 3)), [
      ["Level 1", ["Level 2", "Level 3"]],
    ]);
    assert.deepStrictEqual(shape(parseMarkdownHeadings(fixture("deep.md"), 1)), ["Level 1"]);
  });

  test("keys are unique among repeated siblings and carry the parent path", () => {
    const [root] = parseMarkdownHeadings(fixture("messy.md"), 6);
    const dupes = root.children.filter(c => c.text === "Duplicate").map(c => c.key);
    assert.deepStrictEqual(dupes, ["/Closing hashes/Duplicate", "/Closing hashes/Duplicate~1"]);
  });

  test("line numbers point at the heading (setext: the text line)", () => {
    const [title] = parseMarkdownHeadings("intro\n\nTitle\n===\n\n## Next", 6);
    assert.strictEqual(title.line, 2);
    assert.strictEqual(title.children[0].line, 5);
  });

  test("CRLF input and out-of-range depth don't break it", () => {
    assert.deepStrictEqual(shape(parseMarkdownHeadings("# A\r\n## B\r\n", 0)), ["A"]);
    assert.deepStrictEqual(shape(parseMarkdownHeadings("# A\r\n## B\r\n", 99)), [["A", "B"]]);
    assert.deepStrictEqual(parseMarkdownHeadings("", 6), []);
  });
});
