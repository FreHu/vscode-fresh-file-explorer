import { FlatHeading, OutlineHeading, buildHeadingTree } from "./headingTree";

/** Org-mode's built-in keywords, used until a `#+TODO:` line defines others. */
const DEFAULT_KEYWORDS = ["TODO", "DONE"];

const HEADING = /^(\*+)[ \t]+(.*?)[ \t]*$/;
const BLOCK_BEGIN = /^[ \t]*#\+begin_(\S+)/i;
const BLOCK_END = /^[ \t]*#\+end_(\S+)/i;
/** `#+TODO:`, `#+SEQ_TODO:`, `#+TYP_TODO:` — keywords, with `|` separating open from done states. */
const KEYWORD_LINE = /^[ \t]*#\+(?:seq_|typ_)?todo:[ \t]*(.*)$/i;

/**
 * Headings of an Org-mode document. A heading is stars at column 0 followed by
 * whitespace; its TODO keyword (default TODO / DONE, or those from `#+TODO:`
 * lines) becomes the heading's `tag`, and a priority cookie and trailing tags
 * are dropped from the label. Lines inside `#+BEGIN_…`/`#+END_…` blocks are
 * skipped. Nesting rules: {@link buildHeadingTree}.
 */
export function parseOrgHeadings(source: string, maxDepth: number): OutlineHeading[] {
  const lines = source.split(/\r?\n/);
  const keywords = collectKeywords(lines);
  const flat: FlatHeading[] = [];
  let block: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (block) {
      const end = BLOCK_END.exec(line);
      if (end && end[1].toLowerCase() === block) { block = undefined; }
      continue;
    }
    const begin = BLOCK_BEGIN.exec(line);
    if (begin) {
      block = begin[1].toLowerCase();
      continue;
    }
    const m = HEADING.exec(line);
    if (!m) { continue; }

    let text = m[2];
    let tag: string | undefined;
    const first = /^(\S+)(?:[ \t]+(.*))?$/.exec(text);
    if (first && keywords.has(first[1])) {
      tag = first[1];
      text = first[2] ?? "";
    }
    text = cleanInline(text.replace(/^\[#[A-Za-z0-9]\][ \t]*/, "").replace(/[ \t]+:[\w@#%:]+:[ \t]*$/, ""));
    if (text || tag) { flat.push({ level: m[1].length, text: text || tag!, line: i, tag: text ? tag : undefined }); }
  }
  return buildHeadingTree(flat, maxDepth);
}

/** Keywords from every `#+TODO:`-style line; Org's defaults when there are none. */
function collectKeywords(lines: string[]): Set<string> {
  const found = new Set<string>();
  for (const line of lines) {
    const m = KEYWORD_LINE.exec(line);
    if (!m) { continue; }
    for (const word of m[1].split(/\s+/)) {
      // `|` separates open from done states; `DONE(d!)` carries a fast-access key.
      const kw = word.replace(/\(.*\)$/, "");
      if (kw && kw !== "|") { found.add(kw); }
    }
  }
  return found.size ? found : new Set(DEFAULT_KEYWORDS);
}

/** Plain text for a label: `[[target][description]]` → description, `[[target]]` → target, verbatim markers go. */
function cleanInline(text: string): string {
  return text
    .replace(/\[\[([^\]]*)\]\[([^\]]*)\]\]/g, "$2")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/(^|\s)[=~]([^=~\s][^=~]*?)[=~](?=\s|$)/g, "$1$2")
    .trim();
}
