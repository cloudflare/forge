/**
 * Groups `items` by `keyFn` and calls `report` once per group of size ≥ 2 (in insertion order of
 * the first item in each group). Shared by the three identifier-collision rules so they stay in
 * lockstep on dedup behavior.
 */
export function groupAndReport<T>(items: Iterable<T>, keyFn: (item: T) => string, report: (group: T[]) => void): void {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, [item]);
    } else {
      existing.push(item);
    }
  }
  for (const group of groups.values()) {
    if (group.length >= 2) {
      report(group);
    }
  }
}
