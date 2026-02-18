const RAW = Symbol("raw");

/**
 * Marks a string as safe/pre-escaped so the html tagged template won't escape it.
 * Use for trusted content like CSS strings or pre-built HTML fragments.
 */
export function raw(value: string): { [RAW]: string } {
  return { [RAW]: value };
}

/**
 * HTML tagged template literal helper
 * Escapes values to prevent HTML injection attacks.
 * Values wrapped with raw() are passed through without escaping.
 */
export function html(strings: TemplateStringsArray, ...values: any[]): string {
  let result = strings[0];
  for (let i = 0; i < values.length; i++) {
    const val = values[i];
    result += (val && typeof val === "object" && RAW in val)
      ? val[RAW]
      : escapeHtml(String(val));
    result += strings[i + 1];
  }
  return result;
}

/**
 * CSS tagged template literal helper
 * Returns CSS content as-is (no escaping needed for style content)
 */
export function css(strings: TemplateStringsArray, ...values: any[]): string {
  let result = strings[0];
  for (let i = 0; i < values.length; i++) {
    result += String(values[i]) + strings[i + 1];
  }
  return result;
}

/**
 * Escapes HTML special characters to prevent injection attacks
 */
function escapeHtml(str: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return str.replace(/[&<>"']/g, (char) => map[char]);
}
