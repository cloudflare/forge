import { isPlainObject, isRefNode, resolveChild, resolveNode } from './resolve.ts';
import type { AnyNode, Located, UserContext } from './types.ts';

type Ctx = Pick<UserContext, 'resolve'>;

/** The JSON Schema `type` keyword as a list, with OAS 3.0 `nullable: true` folded in as `"null"`. */
export function schemaTypes(schema: AnyNode): string[] {
  if (!isPlainObject(schema)) {
    return [];
  }
  const types: string[] = [];
  if (typeof schema.type === 'string') {
    types.push(schema.type);
  } else if (Array.isArray(schema.type)) {
    for (const type of schema.type) {
      if (typeof type === 'string') {
        types.push(type);
      }
    }
  }
  if (schema.nullable === true && !types.includes('null')) {
    types.push('null');
  }
  return types;
}

/** The single non-null `type` of a schema, if there is exactly one. */
export function nonNullType(schema: AnyNode): string | undefined {
  const types = schemaTypes(schema).filter((type) => type !== 'null');
  return types.length === 1 ? types[0] : undefined;
}

function isNullSchema(schema: AnyNode): boolean {
  const types = schemaTypes(schema);
  return types.length === 1 && types[0] === 'null';
}

/**
 * Unwraps the wrappers Fern treats as optional/nullable/alias layers:
 * `oneOf`/`anyOf` of exactly one non-null schema plus `{type: "null"}`, and a lone `allOf: [X]`
 * with no sibling structure. Follows `$ref`s throughout.
 */
export function unwrapSchema(ctx: Ctx, located: Located | undefined): Located | undefined {
  let current = located;
  for (let depth = 0; current !== undefined && depth < 32; depth++) {
    const resolved = resolveNode(ctx, current.node, current.location);
    if (resolved === undefined || !isPlainObject(resolved.node)) {
      return resolved;
    }
    const schema = resolved.node;
    const union = Array.isArray(schema.oneOf) ? 'oneOf' : Array.isArray(schema.anyOf) ? 'anyOf' : undefined;
    if (union !== undefined && schema.properties === undefined) {
      const members: AnyNode[] = schema[union];
      const nonNull = members
        .map((member, index) => ({ member, index }))
        .filter(({ member, index }) => {
          const memberResolved = resolveNode(ctx, member, resolved.location.child([union, index]));
          return !isNullSchema(memberResolved?.node);
        });
      if (nonNull.length === 1 && members.length === 2) {
        current = {
          node: nonNull[0]!.member,
          location: resolved.location.child([union, nonNull[0]!.index]),
        };
        continue;
      }
    }
    if (
      Array.isArray(schema.allOf) &&
      schema.allOf.length === 1 &&
      schema.properties === undefined &&
      schema.type === undefined
    ) {
      current = {
        node: schema.allOf[0],
        location: resolved.location.child(['allOf', 0]),
      };
      continue;
    }
    return resolved;
  }
  return current;
}

/** Whether a (resolved) schema describes an object in Fern's eyes. */
export function isObjectSchema(ctx: Ctx, located: Located | undefined, seen = new Set<string>()): boolean {
  const resolved = unwrapSchema(ctx, located);
  if (resolved === undefined || !isPlainObject(resolved.node)) {
    return false;
  }
  const key = resolved.location.absolutePointer;
  if (seen.has(key)) {
    return true;
  }
  seen.add(key);
  const schema = resolved.node;
  const type = nonNullType(schema);
  if (type === 'object') {
    return true;
  }
  if (type !== undefined) {
    return false;
  }
  if (isPlainObject(schema.properties)) {
    return true;
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.every((_member: AnyNode, index: number) =>
      isObjectSchema(
        ctx,
        resolveChild(ctx, { node: schema.allOf, location: resolved.location.child('allOf') }, index),
        seen,
      ),
    );
  }
  return false;
}

export interface CollectedProperty {
  /** The property key as written in `properties`. */
  key: string;
  /** The property schema (unresolved node) and its location. */
  schema: Located;
  /** Whether the property comes from an `allOf` `$ref` member (Fern `extends`). */
  inherited: boolean;
  /** Human-readable chain of `$ref`s the property was inherited through. */
  via: string[];
}

/**
 * Collects properties of an object schema, merging `allOf` members recursively the way Fern does:
 * inline members are merged in place, `$ref` members become inherited (`extends`) properties.
 */
export function collectProperties(ctx: Ctx, located: Located | undefined): CollectedProperty[] {
  const result: CollectedProperty[] = [];
  const seen = new Set<string>();

  const visit = (current: Located | undefined, inherited: boolean, via: string[]): void => {
    const resolved = unwrapSchema(ctx, current);
    if (resolved === undefined || !isPlainObject(resolved.node)) {
      return;
    }
    const key = resolved.location.absolutePointer;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const schema = resolved.node;
    if (isPlainObject(schema.properties)) {
      for (const [propertyKey, propertySchema] of Object.entries(schema.properties)) {
        result.push({
          key: propertyKey,
          schema: {
            node: propertySchema,
            location: resolved.location.child(['properties', propertyKey]),
          },
          inherited,
          via,
        });
      }
    }
    if (Array.isArray(schema.allOf)) {
      schema.allOf.forEach((member: AnyNode, index: number) => {
        const memberLocation = resolved.location.child(['allOf', index]);
        if (isRefNode(member)) {
          visit({ node: member, location: memberLocation }, true, [...via, refName(member.$ref)]);
        } else {
          visit({ node: member, location: memberLocation }, inherited, via);
        }
      });
    }
  };

  visit(located, false, []);
  return result;
}

/** The last segment of a `$ref`, used for messages. */
export function refName(ref: string): string {
  const fragment = ref.includes('#') ? ref.slice(ref.indexOf('#') + 1) : ref;
  const segments = fragment.split('/').filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1] ?? ref;
  return last.replace(/~1/g, '/').replace(/~0/g, '~');
}

export type FernPrimitive =
  | 'STRING'
  | 'INTEGER'
  | 'LONG'
  | 'UINT'
  | 'UINT64'
  | 'DOUBLE'
  | 'FLOAT'
  | 'BOOLEAN'
  | 'DATE_TIME'
  | 'DATE';

/**
 * The Fern primitive a schema imports as, or undefined for non-primitives (objects, arrays,
 * enums, literals, unions). Mirrors Fern's OpenAPI importer.
 */
export function fernPrimitive(ctx: Ctx, located: Located | undefined): FernPrimitive | undefined {
  const resolved = unwrapSchema(ctx, located);
  if (resolved === undefined || !isPlainObject(resolved.node)) {
    return undefined;
  }
  const schema = resolved.node;
  if (Array.isArray(schema.enum) || schema.const !== undefined) {
    return undefined;
  }
  const format = typeof schema.format === 'string' ? schema.format : undefined;
  switch (nonNullType(schema)) {
    case 'boolean':
      return 'BOOLEAN';
    case 'string':
      if (format === 'date-time') {
        return 'DATE_TIME';
      }
      if (format === 'date') {
        return 'DATE';
      }
      return 'STRING';
    case 'integer':
    case 'number': {
      switch (format) {
        case 'int64':
          return 'LONG';
        case 'int32':
          return 'INTEGER';
        case 'uint32':
          return 'UINT';
        case 'uint64':
          return 'UINT64';
        case 'float':
          return 'FLOAT';
        case 'double':
          return 'DOUBLE';
        default:
          return nonNullType(schema) === 'integer' ? 'INTEGER' : 'DOUBLE';
      }
    }
    default:
      return undefined;
  }
}
