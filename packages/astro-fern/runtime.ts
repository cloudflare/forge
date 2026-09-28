/**
 * Resolves a URL hash to a configured execution-target ID.
 * Returns `undefined` when the hash is malformed or the decoded target is not
 * in `availableTargets`.
 */
export function targetFromHash(hash: string, availableTargets: readonly string[]): string | undefined {
  let target: string;
  try {
    target = decodeURIComponent(hash.replace(/^#/, ''));
  } catch {
    return undefined;
  }
  return availableTargets.includes(target) ? target : undefined;
}

/** Replaces any existing hash with the URL-encoded execution-target hash. */
export function targetHref(pathname: string, target: string): string {
  return `${pathname.replace(/#.*$/, '')}#${encodeURIComponent(target)}`;
}
