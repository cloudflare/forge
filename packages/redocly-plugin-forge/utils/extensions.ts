import type { OperationInfo } from './document.ts';
import { isPlainObject, resolveChild } from './resolve.ts';
import type { AnyNode, Located, Location, UserContext } from './types.ts';

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

/** Forge identifier rule (`Name::new`): starts with a letter, letters and digits only. */
export const FORGE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*$/;

/** Short classifier for JSON values suitable for error messages; distinguishes null and array. */
export function describeKind(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

/**
 * Canonical dotted form of an `x-forge-group-name`: a dotted string is returned verbatim, an
 * array of strings is joined with `.`, anything else returns `undefined`.
 */
export function dottedGroupKey(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && value.every((segment) => typeof segment === 'string')) {
    return value.join('.');
  }
  return undefined;
}

/**
 * Invokes `fn` for the operation itself, then once per element of its `x-forge-aliases` array
 * (if any). Rules that validate forge extensions use this to apply the same check at both levels.
 */
export function forEachForgeTarget(
  operation: Pick<OperationInfo, 'node' | 'location'>,
  fn: (node: AnyNode, location: Location) => void,
): void {
  fn(operation.node, operation.location);
  const aliases = operation.node?.['x-forge-aliases'];
  if (Array.isArray(aliases)) {
    aliases.forEach((alias, index) => {
      fn(alias, operation.location.child(['x-forge-aliases', index]));
    });
  }
}
