import { OutlineHeading } from "./headingTree";
import { parseMarkdownHeadings } from "./markdownHeadings";
import { parseOrgHeadings } from "./orgHeadings";
import { parseAsciidocHeadings } from "./asciidocHeadings";

export type OutlineFormat = "markdown" | "org" | "asciidoc";

/**
 * Markdown variants share the markdown parser: MDX, Quarto (`.qmd`) and
 * R Markdown (`.rmd`) code chunks are ``` fences, which it already skips.
 */
const FORMAT_BY_EXTENSION: Record<string, OutlineFormat> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdx": "markdown",
  ".qmd": "markdown",
  ".rmd": "markdown",
  ".org": "org",
  ".adoc": "asciidoc",
  ".asciidoc": "asciidoc",
};

/** The outline format of a file, or undefined when its headings aren't listed. */
export function outlineFormatFor(fsPath: string): OutlineFormat | undefined {
  const dot = fsPath.lastIndexOf(".");
  return dot < 0 ? undefined : FORMAT_BY_EXTENSION[fsPath.slice(dot).toLowerCase()];
}

export function parseOutline(format: OutlineFormat, source: string, maxDepth: number): OutlineHeading[] {
  switch (format) {
    case "markdown": return parseMarkdownHeadings(source, maxDepth);
    case "org": return parseOrgHeadings(source, maxDepth);
    case "asciidoc": return parseAsciidocHeadings(source, maxDepth);
  }
}
