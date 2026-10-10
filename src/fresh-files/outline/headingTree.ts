/** A heading as a format's line scanner finds it, before nesting. */
export interface FlatHeading {
  level: number;
  text: string;
  /** 0-based line of the heading text. */
  line: number;
  /** Short status shown next to the heading, e.g. an Org-mode `TODO` / `DONE` keyword. */
  tag?: string;
}

export interface OutlineHeading extends FlatHeading {
  /** Stable among edits that don't touch this heading or its ancestors: parent key + text (+ `~n` for repeats). */
  key: string;
  children: OutlineHeading[];
}

/**
 * Nest headings by level, best effort: a skipped level nests under the nearest
 * shallower heading, and a document may start at any level. Headings deeper
 * than `maxDepth` (clamped to 1..6) are dropped.
 */
export function buildHeadingTree(flat: FlatHeading[], maxDepth: number): OutlineHeading[] {
  const depth = Math.min(6, Math.max(1, Math.floor(maxDepth)));
  const roots: OutlineHeading[] = [];
  const stack: OutlineHeading[] = [];
  /** Per parent key: how many children so far carry each text. */
  const seen = new Map<string, Map<string, number>>();
  for (const h of flat) {
    if (h.level > depth) { continue; }
    while (stack.length && stack[stack.length - 1].level >= h.level) { stack.pop(); }
    const parent = stack[stack.length - 1];
    const siblings = parent ? parent.children : roots;
    const parentKey = parent ? parent.key : "";
    let counts = seen.get(parentKey);
    if (!counts) { counts = new Map(); seen.set(parentKey, counts); }
    const repeats = counts.get(h.text) ?? 0;
    counts.set(h.text, repeats + 1);
    const key = `${parentKey}/${h.text}${repeats ? `~${repeats}` : ""}`;
    const node: OutlineHeading = { ...h, key, children: [] };
    siblings.push(node);
    stack.push(node);
  }
  return roots;
}
