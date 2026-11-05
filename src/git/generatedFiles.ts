/** Attributes that mark a file as generated: GitHub's (Linguist) and GitLab's. */
export const GENERATED_ATTRIBUTES = ["linguist-generated", "gitlab-generated"] as const;

/**
 * Paths marked generated, from `git check-attr -z <attrs…>` output: NUL-separated
 * `path, attribute, value` triples. Set (`attr`) or `attr=true` marks a path;
 * unset (`-attr`), `attr=false` and unspecified don't. Either attribute is enough.
 */
export function parseGeneratedAttributes(output: string): Set<string> {
  const fields = output.split("\0");
  const generated = new Set<string>();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [path, , value] = [fields[i], fields[i + 1], fields[i + 2]];
    if (value === "set" || value === "true") { generated.add(path); }
  }
  return generated;
}
