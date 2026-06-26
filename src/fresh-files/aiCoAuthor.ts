/**
 * Detection of AI-agent co-authorship from Git commit `Co-authored-by` trailers.
 *
 * Coding agents (Claude Code, GitHub Copilot, Cursor, aider, Devin, …) stamp
 * themselves into the commit *message* as a `Co-authored-by:` trailer rather
 * than the author/committer fields — so this is the only reliable signal. We
 * match on the trailer's **email**, not its display name: the name churns with
 * every model revision (e.g. "Claude Opus 4.8 (1M context)") while the email
 * (`noreply@anthropic.com`) stays stable.
 *
 * Pure + unit-tested. The git layer feeds raw trailer text in; the provider
 * uses the boolean to filter and the tool list to badge.
 */

/**
 * Separator placed between multiple co-author values inside a single trailer
 * field. Must match the `separator=%x1f` token in the `git log` pretty format
 * (ASCII Unit Separator, 0x1F) — a control char that never occurs in names or
 * emails, so it cannot collide with real content the way a comma or `|` would.
 */
export const AI_TRAILER_SEPARATOR = "\x1f";

export interface AiCoAuthorInfo {
  /** True when at least one co-author resolves to a known/configured AI agent. */
  aiCoAuthored: boolean;
  /** Distinct display names of the detected agents (e.g. ["Claude"]), in first-seen order. */
  tools: string[];
}

const NONE: AiCoAuthorInfo = { aiCoAuthored: false, tools: [] };

/** A single co-author trailer value, split into name + email (email may be empty). */
interface CoAuthor {
  name: string;
  email: string;
}

/** Built-in agent identities, matched against a parsed co-author. */
interface KnownAgent {
  tool: string;
  matches: (a: CoAuthor) => boolean;
}

// Email-first matching. Names are only used where no stable agent-specific email
// exists (Copilot shares the generic github.com noreply domain with humans, so
// it MUST be matched by name, not domain).
const KNOWN_AGENTS: readonly KnownAgent[] = [
  { tool: "Claude", matches: (a) => a.email.endsWith("@anthropic.com") },
  { tool: "GitHub Copilot", matches: (a) => a.name.includes("copilot") },
  { tool: "Cursor", matches: (a) => a.email.includes("cursor.com") || a.name === "cursor" || a.name === "cursor agent" },
  { tool: "aider", matches: (a) => a.name === "aider" || a.email.includes("aider") },
  { tool: "Devin", matches: (a) => a.name.includes("devin") || a.email.includes("devin-ai-integration") },
  { tool: "Codex", matches: (a) => a.name === "codex" || a.name.includes("openai codex") },
];

/**
 * Parse a `Co-authored-by` value of the form `Name <email>` into its parts.
 * Tolerates a missing/garbled angle-bracket section (email becomes "").
 * Returned name/email are lowercased+trimmed for case-insensitive matching;
 * `displayName` preserves the original casing for badges.
 */
function parseCoAuthor(raw: string): CoAuthor & { displayName: string } {
  const m = /^(.*?)\s*<([^>]*)>\s*$/.exec(raw);
  const displayName = (m ? m[1] : raw).trim();
  return {
    displayName,
    name: displayName.toLowerCase(),
    email: (m ? m[2] : "").trim().toLowerCase(),
  };
}

/**
 * Classify a raw `Co-authored-by` trailer field (possibly holding several
 * values joined by {@link AI_TRAILER_SEPARATOR}) as AI-authored or not.
 *
 * @param trailerField  Raw trailer text from `git log` (empty string when the
 *                      commit had no co-authors).
 * @param extraEmails   User-configured agent emails for in-house agents, matched
 *                      case-insensitively as exact emails. Pass an empty set if none.
 */
export function detectAiCoAuthors(
  trailerField: string,
  extraEmails: ReadonlySet<string> = new Set(),
): AiCoAuthorInfo {
  if (!trailerField) {
    return NONE;
  }

  const tools: string[] = [];
  const seen = new Set<string>();
  const addTool = (tool: string) => {
    if (!seen.has(tool)) {
      seen.add(tool);
      tools.push(tool);
    }
  };

  for (const value of trailerField.split(AI_TRAILER_SEPARATOR)) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const author = parseCoAuthor(trimmed);

    if (author.email && extraEmails.has(author.email)) {
      // Configured in-house agent — badge with its own display name.
      addTool(author.displayName || author.email);
      continue;
    }

    const known = KNOWN_AGENTS.find((agent) => agent.matches(author));
    if (known) {
      addTool(known.tool);
    }
  }

  return { aiCoAuthored: tools.length > 0, tools };
}
