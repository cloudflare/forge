/**
 * Reports `allOf` members that resolve to a non-object schema (scalar, array, enum). A value
 * cannot simultaneously satisfy an object constraint and a scalar/array constraint, so such an
 * `allOf` is a JSON Schema semantic error.
 *
 * Checks only `$ref` members. Inline composition is left alone since authors sometimes use
 * `allOf` with a single inline sub-schema as a refinement.
 */
import { isPlainObject, isRefNode, resolveNode } from '../utils/resolve.ts';
import { refName, schemaTypes } from '../utils/schema.ts';
import type { AnyNode, Located, RuleDefinition, UserContext } from '../utils/types.ts';

type Ctx = Pick<UserContext, 'resolve'>;

function isObjectLike(ctx: Ctx, located: Located, seen: Set<string> = new Set()): boolean {
  const resolved = resolveNode(ctx, located.node, located.location);
  if (resolved === undefined || !isPlainObject(resolved.node)) {
    return false;
  }
  const key = resolved.location.absolutePointer;
  if (seen.has(key)) {
    return false;
  }
  seen.add(key);
  const schema = resolved.node;
  if (schemaTypes(schema).includes('object') || isPlainObject(schema.properties)) {
    return true;
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.every((member: AnyNode, index: number) =>
      isObjectLike(ctx, { node: member, location: resolved.location.child(['allOf', index]) }, seen),
    );
  }
  return false;
}

function describeNonObject(schema: Record<string, AnyNode>): string {
  const types = schemaTypes(schema).filter((type) => type !== 'null');
  if (types.length === 0) {
    return 'untyped';
  }
  if (Array.isArray(schema.enum)) {
    return `an enum of ${types.join('/')}`;
  }
  return `a ${types.join('/')}`;
}

export const onlyObjectExtensions: RuleDefinition = {
  name: 'only-object-allof-refs',
  sourceRules: ['fern-definition/only-object-extensions'],
  severity: 'error',
  description: '`allOf` members referenced via `$ref` must resolve to object schemas.',
  rule: () => ({
    Schema(schema: AnyNode, ctx: UserContext) {
      if (!isPlainObject(schema) || !Array.isArray(schema.allOf)) {
        return;
      }
      schema.allOf.forEach((member: AnyNode, index: number) => {
        if (!isRefNode(member)) {
          return;
        }
        const location = ctx.location.child(['allOf', index]);
        const target = resolveNode(ctx, member, location);
        if (target === undefined || !isPlainObject(target.node)) {
          return;
        }
        if (isObjectLike(ctx, target)) {
          return;
        }
        ctx.report({
          message: `allOf $ref "${refName(member.$ref)}" is ${describeNonObject(target.node)}, not an object; a value cannot be both an object and a non-object.`,
          location: location.child('$ref').key(),
        });
      });
    },
  }),
};
