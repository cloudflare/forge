/**
 * Reports `allOf` `$ref` members that Fern turns into `extends` but that do not resolve to an
 * object. Fern only creates `extends` for schemas it imports as objects (`properties` or `allOf`,
 * not a single-member `allOf`, which is an alias). These parents are not inherited and are
 * skipped:
 *
 * - `$ref`s to discriminated unions and to `oneOf`/`anyOf` schemas (whose properties Fern inlines);
 * - local `$ref`s outside `#/components/schemas/`;
 * - parents that share a property name with another `$ref` parent of the same `allOf`: Fern
 *   inlines the properties of all such parents instead of extending them.
 *
 * A nullable parent (`nullable: true`, or `type: [object, "null"]`) that is itself an object is
 * extended as that object; any other nullable parent (a nullable alias of an object, a nullable
 * primitive, a nullable alias of a nullable object) is a nullable alias and is reported.
 *
 * Options:
 * - `inlineAllOfSchemas` (boolean, default `false`): set when generators.yml enables
 *   `inline-all-of-schemas`; Fern then inlines every `allOf` parent and the rule reports nothing.
 */
import { isPlainObject, isRefNode, resolveNode } from '../utils/resolve.ts';
import { refName, schemaTypes } from '../utils/schema.ts';
import { convertsToObject, describeKind, fernSchemaKind } from '../utils/structure.ts';
import type { AnyNode, Located, RuleDefinition, UserContext } from '../utils/types.ts';

type Ctx = Pick<UserContext, 'resolve'>;

/** The schema without its top-level `nullable: true` / `"null"` type. */
function withoutNull(schema: Record<string, AnyNode>): Record<string, AnyNode> {
  const copy = { ...schema };
  delete copy.nullable;
  if (Array.isArray(copy.type)) {
    const types = copy.type.filter((type: AnyNode) => type !== 'null');
    copy.type = types.length === 1 ? types[0] : types;
  }
  return copy;
}

/**
 * The property names Fern collects from an `allOf` parent: its own non-ignored `properties` and,
 * recursively, those of its `allOf` members.
 */
function propertyNames(ctx: Ctx, located: Located, seen: Set<string> = new Set()): Set<string> {
  const names = new Set<string>();
  const resolved = resolveNode(ctx, located.node, located.location);
  if (resolved === undefined || !isPlainObject(resolved.node)) {
    return names;
  }
  const key = resolved.location.absolutePointer;
  if (seen.has(key)) {
    return names;
  }
  seen.add(key);
  const schema = resolved.node;
  if (Array.isArray(schema.allOf)) {
    schema.allOf.forEach((member: AnyNode, index: number) => {
      const child = {
        node: member,
        location: resolved.location.child(['allOf', index]),
      };
      for (const name of propertyNames(ctx, child, seen)) {
        names.add(name);
      }
    });
  }
  if (isPlainObject(schema.properties)) {
    for (const [name, property] of Object.entries(schema.properties)) {
      if (!(isPlainObject(property) && property['x-fern-ignore'] === true)) {
        names.add(name);
      }
    }
  }
  return names;
}

/**
 * The kind of Fern type an `allOf` parent declaration converts to. Fern declares a nullable
 * schema that is itself an object as that object (and extends it), but every other nullable
 * schema, including an alias of an object, as a nullable alias. A `$ref` to an alias (a schema
 * that is itself a `$ref`) is the kind of the aliased schema, where nullable stays nullable.
 */
function parentKind(
  ctx: Ctx,
  ref: string,
  target: Located<Record<string, AnyNode>>,
): ReturnType<typeof fernSchemaKind> {
  const hash = ref.indexOf('#');
  const pointer = hash === -1 ? '#/' : ref.slice(hash);
  const isAlias = decodeURIComponent(pointer) !== decodeURIComponent(target.location.pointer);
  if (!isAlias && schemaTypes(target.node).includes('null')) {
    const nonNull = {
      node: withoutNull(target.node),
      location: target.location,
    };
    if (convertsToObject(ctx, nonNull)) {
      return { kind: 'object', schema: target };
    }
    return { kind: 'nullable', schema: target };
  }
  return fernSchemaKind(ctx, target);
}

interface Parent {
  index: number;
  ref: string;
  location: Located['location'];
  target: Located<Record<string, AnyNode>>;
}

export const onlyObjectExtensions: RuleDefinition = {
  name: 'only-object-extensions',
  sourceRules: ['fern-definition/only-object-extensions'],
  severity: 'error',
  description: 'Schemas referenced from `allOf` (Fern `extends`) must be objects.',
  rule: (options: { inlineAllOfSchemas?: boolean } = {}) => ({
    Schema(schema: AnyNode, ctx: UserContext) {
      if (options.inlineAllOfSchemas === true || !isPlainObject(schema) || !Array.isArray(schema.allOf)) {
        return;
      }
      const located = { node: schema, location: ctx.location };
      if (!convertsToObject(ctx, located)) {
        return;
      }
      const parents: Parent[] = [];
      schema.allOf.forEach((member: AnyNode, index: number) => {
        if (!isRefNode(member)) {
          return;
        }
        const ref = member.$ref;
        if (ref.startsWith('#') && !ref.startsWith('#/components/schemas/')) {
          return;
        }
        const location = ctx.location.child(['allOf', index]);
        const target = resolveNode(ctx, member, location);
        if (target === undefined || !isPlainObject(target.node)) {
          return;
        }
        const discriminator = target.node.discriminator;
        if (
          (isPlainObject(discriminator) && discriminator.mapping != null) ||
          target.node.oneOf != null ||
          target.node.anyOf != null
        ) {
          return;
        }
        parents.push({ index, ref, location, target });
      });

      const owners = new Map<string, number>();
      const names = parents.map((parent) => propertyNames(ctx, parent.target));
      for (const parentNames of names) {
        for (const name of parentNames) {
          owners.set(name, (owners.get(name) ?? 0) + 1);
        }
      }

      parents.forEach((parent, position) => {
        const inlined = [...names[position]!].some((name) => (owners.get(name) ?? 0) > 1);
        if (inlined) {
          return;
        }
        const { kind, schema: resolved } = parentKind(ctx, parent.ref, parent.target);
        if (kind === 'object' || kind === 'custom') {
          return;
        }
        ctx.report({
          message: `Objects can only extend other objects, and "${refName(parent.ref)}" is not an object: it is ${describeKind(kind, resolved.node)}. Fern turns this \`allOf\` \`$ref\` into an \`extends\`, so the referenced schema must be an object schema with \`properties\`.`,
          location: parent.location.child('$ref').key(),
        });
      });
    },
  }),
};
