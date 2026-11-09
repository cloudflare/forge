/**
 * Reports `in: query` parameters whose schema is, or transitively contains, a schema Fern's
 * importer turns into a discriminated union (see `isDiscriminatedUnion`). The search follows the
 * types Fern generates: `$ref`s, array `items`, map values (`additionalProperties` without
 * `properties`), non-ignored object `properties`, inherited `allOf` parents (not discriminated
 * union parents, which Fern does not inherit; the object members of `oneOf`/`anyOf` parents, whose
 * properties Fern inlines) and the members of undiscriminated unions, and stops at cycles.
 */
import { getOperations, rootOf } from '../utils/document.ts';
import { isPlainObject, isRefNode, resolveNode } from '../utils/resolve.ts';
import { refName, schemaTypes } from '../utils/schema.ts';
import { isDiscriminatedUnion, isFernEndpoint } from '../utils/structure.ts';
import type { AnyNode, Located, RuleDefinition, UserContext } from '../utils/types.ts';

interface Found {
  /** Name of the discriminated union: its `$ref` name, or `inline` for inline schemas. */
  name: string | undefined;
  /** Keywords walked from the parameter schema to the union. */
  path: string[];
}

function findDiscriminatedUnion(ctx: UserContext, start: Located): Found | undefined {
  const visited = new Set<string>();

  const visit = (current: Located, path: string[]): Found | undefined => {
    const currentName = isRefNode(current.node) ? refName(current.node.$ref) : undefined;
    const resolved = resolveNode(ctx, current.node, current.location);
    if (resolved === undefined || !isPlainObject(resolved.node)) {
      return undefined;
    }
    const key = resolved.location.absolutePointer;
    if (visited.has(key)) {
      return undefined;
    }
    visited.add(key);
    const schema = resolved.node;
    if (schema['x-fern-type'] !== undefined) {
      return undefined;
    }
    if (isDiscriminatedUnion(ctx, resolved)) {
      return { name: currentName, path };
    }
    const visitChild = (keys: (string | number)[], label: string): Found | undefined => {
      let node: AnyNode = schema;
      for (const segment of keys) {
        node = node?.[segment];
      }
      if (node === undefined) {
        return undefined;
      }
      return visit({ node, location: resolved.location.child(keys) }, [...path, label]);
    };
    const first = (candidates: (() => Found | undefined)[]): Found | undefined => {
      for (const candidate of candidates) {
        const found = candidate();
        if (found !== undefined) {
          return found;
        }
      }
      return undefined;
    };

    const candidates: (() => Found | undefined)[] = [];
    if (schemaTypes(schema).includes('array')) {
      candidates.push(() => visitChild(['items'], 'items'));
    }
    const hasProperties = isPlainObject(schema.properties) && Object.keys(schema.properties).length > 0;
    const allOf: AnyNode[] = Array.isArray(schema.allOf) ? schema.allOf : [];
    if (isPlainObject(schema.additionalProperties) && !hasProperties && allOf.length === 0) {
      candidates.push(() => visitChild(['additionalProperties'], 'additionalProperties'));
    }
    if (hasProperties) {
      for (const [property, value] of Object.entries(schema.properties)) {
        if (isPlainObject(value) && value['x-fern-ignore'] === true) {
          continue;
        }
        candidates.push(() => visitChild(['properties', property], `properties.${property}`));
      }
    }
    const filteredAllOf = allOf
      .map((member, index) => ({ member, index }))
      .filter(({ member }) => isRefNode(member) || (isPlainObject(member) && Object.keys(member).length > 0));
    const allOfIsAlias =
      !hasProperties &&
      filteredAllOf.length === 1 &&
      (schema.additionalProperties == null || schema.additionalProperties === false);
    for (const { member, index } of filteredAllOf) {
      const label = `allOf[${index}]`;
      if (allOfIsAlias || !isRefNode(member)) {
        candidates.push(() => visitChild(['allOf', index], label));
        continue;
      }
      const parent = resolveNode(ctx, member, resolved.location.child(['allOf', index]));
      if (parent === undefined || !isPlainObject(parent.node)) {
        continue;
      }
      if (isPlainObject(parent.node.discriminator) && parent.node.discriminator.mapping != null) {
        continue;
      }
      const variants = Array.isArray(parent.node.oneOf)
        ? 'oneOf'
        : Array.isArray(parent.node.anyOf)
          ? 'anyOf'
          : undefined;
      if (variants === undefined) {
        candidates.push(() => visitChild(['allOf', index], label));
        continue;
      }
      parent.node[variants].forEach((variant: AnyNode, position: number) => {
        candidates.push(() =>
          visit(
            {
              node: variant,
              location: parent.location.child([variants, position]),
            },
            [...path, label, `${variants}[${position}]`],
          ),
        );
      });
    }
    for (const keyword of ['oneOf', 'anyOf'] as const) {
      const members = schema[keyword];
      if (!Array.isArray(members)) {
        continue;
      }
      members.forEach((_member: AnyNode, index: number) => {
        candidates.push(() => visitChild([keyword, index], `${keyword}[${index}]`));
      });
    }
    return first(candidates);
  };

  return visit(start, []);
}

export const noComplexQueryParams: RuleDefinition = {
  name: 'no-complex-query-params',
  vendor: 'fern',
  sourceRules: ['fern-definition/no-complex-query-params'],
  severity: 'error',
  description: 'Query parameters cannot use schemas that contain discriminated unions.',
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        const reported = new Set<string>();
        for (const operation of getOperations(ctx, rootOf(root, ctx))) {
          if (!isFernEndpoint(operation)) {
            continue;
          }
          for (const parameter of operation.parameters) {
            if (
              parameter.in !== 'query' ||
              parameter.node.schema === undefined ||
              parameter.node['x-fern-ignore'] === true
            ) {
              continue;
            }
            const schemaLocation = parameter.location.child('schema');
            const reportKey = schemaLocation.absolutePointer;
            if (reported.has(reportKey)) {
              continue;
            }
            const found = findDiscriminatedUnion(ctx, {
              node: parameter.node.schema,
              location: schemaLocation,
            });
            if (found === undefined) {
              continue;
            }
            reported.add(reportKey);
            const union =
              found.name === undefined ? 'an inline discriminated union' : `the discriminated union "${found.name}"`;
            const relation =
              found.path.length === 0 ? `is ${union}` : `contains ${union} (at ${found.path.join(' > ')})`;
            ctx.report({
              message: `\`in: query\` parameter "${parameter.name}" has a schema that ${relation}. Discriminated unions are not valid types for query parameters. Fern imports a oneOf/anyOf as a discriminated union when it has a \`discriminator.mapping\` or when each member has a distinct single-value string \`enum\`/\`const\` in the same property; on a oneOf, \`x-fern-discriminated: false\` imports it as an undiscriminated union instead.`,
              location: schemaLocation.key(),
            });
          }
        }
      },
    },
  }),
};
