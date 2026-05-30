// Pure version logic — no `vscode` import on purpose, so it unit-tests in
// plain Node without booting an Extension Host.

export type ChangeLevel = "patch" | "minor" | "major";

const RANK: Record<ChangeLevel, number> = { patch: 1, minor: 2, major: 3 };

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

/** Parse the leading `major.minor.patch` of a version, ignoring any
 *  `-prerelease` / `+build` suffix. Returns null if it isn't parseable. */
export function parse(version: string): SemVer | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) {
    return null;
  }
  return { major: +match[1], minor: +match[2], patch: +match[3] };
}

/** The level at which `current` exceeds `previous`, or null if `current`
 *  is not strictly greater (same version, downgrade, or unparseable). */
export function changeLevel(previous: string, current: string): ChangeLevel | null {
  const a = parse(previous);
  const b = parse(current);
  if (!a || !b) {
    return null;
  }
  if (b.major !== a.major) {
    return b.major > a.major ? "major" : null;
  }
  if (b.minor !== a.minor) {
    return b.minor > a.minor ? "minor" : null;
  }
  if (b.patch !== a.patch) {
    return b.patch > a.patch ? "patch" : null;
  }
  return null;
}

/** Should we notify, given the previous version, the current version, and
 *  the smallest level the user wants to hear about? */
export function shouldNotify(previous: string, current: string, threshold: ChangeLevel): boolean {
  const level = changeLevel(previous, current);
  if (!level) {
    return false;
  }
  return RANK[level] >= RANK[threshold];
}
