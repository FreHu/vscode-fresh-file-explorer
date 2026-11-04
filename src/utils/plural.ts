// Bundled into the webviews too: no vscode import.

/**
 * `"1 file"` / `"3 files"`. `pluralForm` covers irregular words (`"match"` → `"matches"`).
 * English only: the extension isn't localized. If it ever is, switch to Intl.PluralRules here.
 */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
