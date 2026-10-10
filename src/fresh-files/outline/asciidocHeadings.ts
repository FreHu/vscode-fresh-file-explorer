import { FlatHeading, OutlineHeading, buildHeadingTree } from "./headingTree";

/** `== Title` (or Asciidoctor's Markdown-style `## Title`), optionally closed by the same marks. */
const SECTION = /^(={1,6}|#{1,6})[ \t]+(\S.*?)(?:[ \t]+\1)?[ \t]*$/;
/**
 * Delimited blocks whose content is not parsed for sections: listing `----`,
 * literal `....`, example `====`, sidebar `****`, quote `____`, comment `////`,
 * passthrough `++++` (4+ marks), and fenced code. A block closes on the same line.
 */
const DELIMITER = /^(-{4,}|\.{4,}|={4,}|\*{4,}|_{4,}|\/{4,}|\+{4,}|`{3,})[ \t]*$/;

/**
 * Section titles of an AsciiDoc document: `=` is the document title (level 1),
 * `==` its sections, and so on. Lines inside delimited blocks are skipped, as
 * are single-line `//` comments and `.Block titles`. Nesting rules:
 * {@link buildHeadingTree}.
 */
export function parseAsciidocHeadings(source: string, maxDepth: number): OutlineHeading[] {
  const lines = source.split(/\r?\n/);
  const flat: FlatHeading[] = [];
  let block: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const delimiter = DELIMITER.exec(line);
    if (block) {
      if (delimiter && delimiter[1] === block) { block = undefined; }
      continue;
    }
    if (delimiter) {
      block = delimiter[1];
      continue;
    }
    const m = SECTION.exec(line);
    if (!m) { continue; }
    const text = cleanInline(m[2]);
    if (text) { flat.push({ level: m[1].length, text, line: i }); }
  }
  return buildHeadingTree(flat, maxDepth);
}

/** Plain text for a label: link and xref text kept, bold / italic / monospace marks go. */
function cleanInline(text: string): string {
  return text
    .replace(/<<[^,>]*,([^>]*)>>/g, "$1")
    .replace(/<<([^>]*)>>/g, "$1")
    .replace(/\b(?:https?:\/\/|link:|xref:|mailto:)[^\s[]*\[([^\]]*)\]/g, "$1")
    // Only at word boundaries, like AsciiDoc's constrained marks, so `my_var_name` survives.
    .replace(/(^|[\s(])(\*{1,2}|_{1,2}|`{1,2})(\S(?:.*?\S)?)\2(?=$|[\s),.;:!?])/g, "$1$3")
    .trim();
}
