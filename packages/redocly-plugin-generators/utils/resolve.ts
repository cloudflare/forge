import type { AnyNode, Located, Location, UserContext } from './types.ts';

const MAX_REF_HOPS = 64;

export function isPlainObject(value: unknown): value is Record<string, AnyNode> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRefNode(value: unknown): value is { $ref: string } {
  return isPlainObject(value) && typeof value.$ref === 'string';
}

/**
 * Follows a chain of `$ref`s starting at `node` (which lives at `location`).
 * Returns undefined when a reference cannot be resolved; `no-unresolved-refs` reports those.
 */
export function resolveNode<T = AnyNode>(
  ctx: Pick<UserContext, 'resolve'>,
  node: AnyNode,
  location: Location,
): Located<T> | undefined {
  let current: AnyNode = node;
  let currentLocation = location;
  for (let hops = 0; isRefNode(current); hops++) {
    if (hops > MAX_REF_HOPS) {
      return undefined;
    }
    const resolved = ctx.resolve(current, currentLocation.source.absoluteRef);
    if (resolved.node === undefined || resolved.location === undefined) {
      return undefined;
    }
    current = resolved.node;
    currentLocation = resolved.location;
  }
  if (current === undefined) {
    return undefined;
  }
  return { node: current as T, location: currentLocation };
}

/** Resolves `parent.node[key]`, following `$ref`s. */
export function resolveChild<T = AnyNode>(
  ctx: Pick<UserContext, 'resolve'>,
  parent: Located,
  key: string | number,
): Located<T> | undefined {
  if (!isPlainObject(parent.node) && !Array.isArray(parent.node)) {
    return undefined;
  }
  const value = (parent.node as AnyNode)[key];
  if (value === undefined) {
    return undefined;
  }
  return resolveNode<T>(ctx, value, parent.location.child([key]));
}
