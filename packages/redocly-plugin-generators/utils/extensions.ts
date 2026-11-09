import { isPlainObject, resolveChild } from './resolve.ts';
import type { AnyNode, Located, UserContext } from './types.ts';

type Ctx = Pick<UserContext, 'resolve'>;

/** Reads an `x-*` extension (or any child) of a located node, following `$ref`s. */
export function readExtension(ctx: Ctx, container: Located, key: string): Located | undefined {
  if (!isPlainObject(container.node) || container.node[key] === undefined) {
    return undefined;
  }
  return (
    resolveChild(ctx, container, key) ?? {
      node: container.node[key],
      location: container.location.child([key]),
    }
  );
}

/** `{name}` placeholders of a path template, in order, including repeats. */
export function pathPlaceholders(path: string): string[] {
  return Array.from(path.matchAll(/\{([^}]*)\}/g), (match) => match[1]!);
}

/** Placeholders that appear more than once, each listed once. */
export function duplicatePlaceholders(path: string): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const placeholder of pathPlaceholders(path)) {
    if (seen.has(placeholder)) {
      duplicates.add(placeholder);
    }
    seen.add(placeholder);
  }
  return [...duplicates];
}

/** A short rendering of an arbitrary extension value for messages. */
export function describeValue(value: AnyNode): string {
  if (typeof value === 'string') {
    return `'${value}'`;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Whether a value is a string with at least one character. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
