import * as assert from "assert";
import { AI_TRAILER_SEPARATOR, detectAiCoAuthors } from "../../fresh-files/aiCoAuthor";

/** Join multiple co-author trailer values the way the git pretty format does. */
function field(...values: string[]): string {
  return values.join(AI_TRAILER_SEPARATOR);
}

suite("detectAiCoAuthors", () => {
  test("empty field → not AI co-authored", () => {
    assert.deepStrictEqual(detectAiCoAuthors(""), { aiCoAuthored: false, tools: [] });
  });

  test("Claude by email (name varies across model revisions)", () => {
    const result = detectAiCoAuthors("Claude Opus 4.8 (1M context) <noreply@anthropic.com>");
    assert.strictEqual(result.aiCoAuthored, true);
    assert.deepStrictEqual(result.tools, ["Claude"]);
  });

  test("matches Claude on email even with an unrelated display name", () => {
    const result = detectAiCoAuthors("Some Bot <noreply@anthropic.com>");
    assert.strictEqual(result.aiCoAuthored, true);
    assert.deepStrictEqual(result.tools, ["Claude"]);
  });

  test("GitHub Copilot matched by name (shares the generic github noreply domain)", () => {
    const result = detectAiCoAuthors("Copilot <198982749+Copilot@users.noreply.github.com>");
    assert.deepStrictEqual(result.tools, ["GitHub Copilot"]);
  });

  test("a human on the github noreply domain is NOT flagged", () => {
    const result = detectAiCoAuthors("Jane Dev <12345+jane@users.noreply.github.com>");
    assert.strictEqual(result.aiCoAuthored, false);
  });

  test("Cursor, aider, Devin, Codex", () => {
    assert.deepStrictEqual(detectAiCoAuthors("Cursor Agent <cursoragent@cursor.com>").tools, ["Cursor"]);
    assert.deepStrictEqual(detectAiCoAuthors("aider (aider) <aider@aider.chat>").tools, ["aider"]);
    assert.deepStrictEqual(detectAiCoAuthors("Devin AI <devin-ai-integration[bot]@users.noreply.github.com>").tools, ["Devin"]);
    assert.deepStrictEqual(detectAiCoAuthors("Codex <codex@openai.com>").tools, ["Codex"]);
  });

  test("plain human co-author → not AI", () => {
    assert.strictEqual(detectAiCoAuthors("Bob Smith <bob@example.com>").aiCoAuthored, false);
  });

  test("multiple co-authors: human + Claude → AI, deduped tools", () => {
    const result = detectAiCoAuthors(field(
      "Bob Smith <bob@example.com>",
      "Claude <noreply@anthropic.com>",
      "Claude <noreply@anthropic.com>",
    ));
    assert.strictEqual(result.aiCoAuthored, true);
    assert.deepStrictEqual(result.tools, ["Claude"], "duplicate agents collapse to one tool entry");
  });

  test("tools preserve first-seen order across distinct agents", () => {
    const result = detectAiCoAuthors(field(
      "Copilot <x@users.noreply.github.com>",
      "Claude <noreply@anthropic.com>",
    ));
    assert.deepStrictEqual(result.tools, ["GitHub Copilot", "Claude"]);
  });

  test("configured in-house email is matched case-insensitively, badged by display name", () => {
    const extra = new Set(["bot@yourcompany.com"]);
    const result = detectAiCoAuthors("Internal Agent <Bot@YourCompany.com>", extra);
    assert.strictEqual(result.aiCoAuthored, true);
    assert.deepStrictEqual(result.tools, ["Internal Agent"]);
  });

  test("configured email does not affect commits that don't use it", () => {
    const extra = new Set(["bot@yourcompany.com"]);
    assert.strictEqual(detectAiCoAuthors("Bob <bob@example.com>", extra).aiCoAuthored, false);
  });

  test("malformed trailer value without angle brackets does not throw", () => {
    assert.doesNotThrow(() => detectAiCoAuthors("just-a-name-no-email"));
    assert.strictEqual(detectAiCoAuthors("just-a-name-no-email").aiCoAuthored, false);
  });

  test("blank values between separators are ignored", () => {
    const result = detectAiCoAuthors(field("", "Claude <noreply@anthropic.com>", ""));
    assert.deepStrictEqual(result.tools, ["Claude"]);
  });
});
