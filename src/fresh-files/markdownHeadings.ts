// Pure, vscode-free: unit-tested against src/test/fixtures/markdown-headings/.

export interface MarkdownHeading {
  level: number;
  text: string;
  /** 0-based line of the heading (for setext, the text line, not the underline). */
  line: number;
  /** Stable among edits that don't touch this heading or its ancestors: parent key + text (+ `~n` for repeats). */
  key: string;
  children: MarkdownHeading[];
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
/** Lines a setext underline can't turn into a heading. */
const NOT_PARAGRAPH = /^ {0,3}([-*+]\s|\d+[.)]\s|>|#)|^( {4}|\t)/;

/**
 * Headings of a markdown document as a tree, best effort. Skipped levels nest
 * under the nearest shallower heading, a document may start at any level, and
 * headings deeper than `maxDepth` are dropped. Fenced code (closed or not),
 * indented code and YAML front matter are skipped, as VS Code's outline does.
 * Not a CommonMark implementation: lazy continuation and HTML blocks are ignored.
 */
export function parseMarkdownHeadings(source: string, maxDepth: number): MarkdownHeading[] {
  const depth = Math.min(6, Math.max(1, Math.floor(maxDepth)));
  const lines = source.split(/\r?\n/);
  const flat: { level: number; text: string; line: number }[] = [];

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

  return buildTree(flat.filter(h => h.level <= depth));
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

function buildTree(flat: { level: number; text: string; line: number }[]): MarkdownHeading[] {
  const roots: MarkdownHeading[] = [];
  const stack: MarkdownHeading[] = [];
  /** Per parent key: how many children so far carry each text. */
  const seen = new Map<string, Map<string, number>>();
  for (const h of flat) {
    while (stack.length && stack[stack.length - 1].level >= h.level) { stack.pop(); }
    const parent = stack[stack.length - 1];
    const siblings = parent ? parent.children : roots;
    const parentKey = parent ? parent.key : "";
    let counts = seen.get(parentKey);
    if (!counts) { counts = new Map(); seen.set(parentKey, counts); }
    const repeats = counts.get(h.text) ?? 0;
    counts.set(h.text, repeats + 1);
    const key = `${parentKey}/${h.text}${repeats ? `~${repeats}` : ""}`;
    const node: MarkdownHeading = { ...h, key, children: [] };
    siblings.push(node);
    stack.push(node);
  }
  return roots;
}
