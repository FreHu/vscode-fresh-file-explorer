import { html } from "../utils/templateHelpers";
import type { MatchRange } from "./logLSearch";

export type MessageTokenKind = "trailer" | "email" | "code" | "link" | "issue" | "hash";

export interface MessageToken {
  start: number;
  end: number;
  kind: MessageTokenKind;
}

/** Same highlighting as the commit message grammar (syntaxes/commit-message.tmLanguage.json). */
const PATTERNS: readonly (readonly [MessageTokenKind, RegExp])[] = [
  ["code", /`[^`\n]+`/g],
  ["link", /\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g],
  ["trailer", /^(?:[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+|Refs?|See|Issue|Bug)(?=:\s)|^(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)(?=:?\s)/gim],
  ["email", /<[^<>\s]+@[^<>\s]+>/g],
  ["issue", /(?<![\w/])(?:[\w.-]+\/[\w.-]+)?#\d+\b/g],
  ["hash", /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g],
];

/** Non-overlapping tokens sorted by start; an earlier pattern wins an overlap (no issue refs inside a link). */
export function tokenizeCommitMessage(text: string): MessageToken[] {
  const tokens: MessageToken[] = [];
  for (const [kind, re] of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (!tokens.some(t => start < t.end && end > t.start)) { tokens.push({ start, end, kind }); }
    }
  }
  return tokens.sort((a, b) => a.start - b.start);
}

export interface MessageParts {
  subject: string;
  /** Index where the body starts (after the blank lines), or -1 without a body. */
  bodyStart: number;
}

export function splitCommitMessage(message: string): MessageParts {
  const newline = message.indexOf("\n");
  if (newline < 0) { return { subject: message, bodyStart: -1 }; }
  const rest = message.slice(newline).search(/\S/);
  return { subject: message.slice(0, newline), bodyStart: rest < 0 ? -1 : newline + rest };
}

/**
 * HTML for `message.slice(from, to)`, with token spans and `<mark class="hl">` for
 * search ranges (given as offsets into the whole message).
 */
export function renderMessageSlice(message: string, from: number, to: number, searchRanges: readonly MatchRange[] = []): string {
  const tokens = tokenizeCommitMessage(message).filter(t => t.end > from && t.start < to);
  const ranges = searchRanges.filter(([s, e]) => e > from && s < to && e > s);
  const cuts = new Set([from, to]);
  for (const t of tokens) { cuts.add(Math.max(t.start, from)); cuts.add(Math.min(t.end, to)); }
  for (const [s, e] of ranges) { cuts.add(Math.max(s, from)); cuts.add(Math.min(e, to)); }
  const points = [...cuts].sort((a, b) => a - b);

  let out = "";
  for (let i = 0; i < points.length - 1; i++) {
    const [s, e] = [points[i], points[i + 1]];
    const token = tokens.find(t => t.start <= s && e <= t.end);
    const hit = ranges.some(([rs, re]) => rs <= s && e <= re);
    let piece = html`${message.slice(s, e)}`;
    if (hit) { piece = `<mark class="hl">${piece}</mark>`; }
    if (token?.kind === "link") {
      piece = html`<a class="cm-link" href="${message.slice(token.start, token.end)}">` + piece + "</a>";
    } else if (token) {
      piece = `<span class="cm-${token.kind}">${piece}</span>`;
    }
    out += piece;
  }
  return out;
}
