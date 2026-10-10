import { FlatHeading, OutlineHeading, buildHeadingTree } from "./headingTree";

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
/** Lines a setext underline can't turn into a heading. */
const NOT_PARAGRAPH = /^ {0,3}([-*+]\s|\d+[.)]\s|>|#)|^( {4}|\t)/;

/**
 * Headings of a markdown document as a tree (nesting rules: {@link buildHeadingTree}).
 * Fenced code (closed or not), indented code and YAML front matter are skipped,
 * as VS Code's outline does; a setext heading's line is its text line. Not a
 * CommonMark implementation: lazy continuation and HTML blocks are ignored.
 */
export function parseMarkdownHeadings(source: string, maxDepth: number): OutlineHeading[] {
  const lines = source.split(/\r?\n/);
  const flat: FlatHeading[] = [];

  let i = skipFrontMatter(lines);
  let fence: { char: string; length: number } | undefined;
  let prevParagraph: { text: string; line: number } | undefined;

  for (; i < lines.length; i++) {
    const line = lines[i];

    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        fence = undefined;
      }
      continue;
    }

    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = { char: open[1][0], length: open[1].length };
      prevParagraph = undefined;
      continue;
    }

    const atx = ATX.exec(line);
    if (atx) {
      const text = cleanInline(stripClosingHashes(atx[2] ?? ""));
      if (text) { flat.push({ level: atx[1].length, text, line: i }); }
      prevParagraph = undefined;
      continue;
    }

    const underline = SETEXT_UNDERLINE.exec(line);
    if (underline && prevParagraph) {
      const text = cleanInline(prevParagraph.text);
      if (text) { flat.push({ level: underline[1][0] === "=" ? 1 : 2, text, line: prevParagraph.line }); }
      prevParagraph = undefined;
      continue;
    }

    prevParagraph = line.trim() && !NOT_PARAGRAPH.test(line) ? { text: line, line: i } : undefined;
  }

  return buildHeadingTree(flat, maxDepth);
}

/** Index of the first line after a leading `---` … `---`/`...` block; 0 when there is none or it never closes. */
function skipFrontMatter(lines: string[]): number {
  if (lines[0]?.trim() !== "---") { return 0; }
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "---" || t === "...") { return i + 1; }
  }
  return 0;
}

/** `Title ##` → `Title`; a heading made only of hashes is empty. */
function stripClosingHashes(text: string): string {
  if (/^#+$/.test(text)) { return ""; }
  return text.replace(/[ \t]+#+[ \t]*$/, "");
}

/** Plain text for a label: links and images keep their text, emphasis and code markers go. */
function cleanInline(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/`+([^`]+)`+/g, "$1")
    .trim();
}
