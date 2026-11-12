/**
 * Reports `in: query` parameters whose schema is, or transitively contains, a schema with an
 * OAS `discriminator.mapping`. Discriminated unions cannot be serialized as URL query strings,
 * since there is no standard way to express "pick one of these shapes" in `?k=v&...` form.
 *
 * Traversal: follow `$ref`, array `items`, `additionalProperties`, object `properties`, and
 * composition keywords (`allOf`, `oneOf`, `anyOf`). Stops at cycles.
 */
import { getOperations, rootOf } from '../utils/document.ts';
import { isPlainObject, isRefNode, resolveNode } from '../utils/resolve.ts';
import { refName } from '../utils/schema.ts';
import type { AnyNode, Located, RuleDefinition, UserContext } from '../utils/types.ts';

interface Found {
  name: string | undefined;
  path: string[];
}

function hasDiscriminatorMapping(schema: Record<string, unknown>): boolean {
  const discriminator = schema.discriminator;
  return (
    isPlainObject(discriminator) && discriminator.mapping !== null && discriminator.mapping !== undefined
  );
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
    if (hasDiscriminatorMapping(schema)) {
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

    if (schema.items !== undefined) {
      const found = visitChild(['items'], 'items');
      if (found !== undefined) return found;
    }
    if (isPlainObject(schema.additionalProperties)) {
      const found = visitChild(['additionalProperties'], 'additionalProperties');
      if (found !== undefined) return found;
    }
    if (isPlainObject(schema.properties)) {
      for (const property of Object.keys(schema.properties)) {
        const found = visitChild(['properties', property], `properties.${property}`);
        if (found !== undefined) return found;
      }
    }
    for (const keyword of ['allOf', 'oneOf', 'anyOf'] as const) {
      const members = schema[keyword];
      if (!Array.isArray(members)) {
        continue;
      }
      for (let index = 0; index < members.length; index++) {
        const found = visitChild([keyword, index], `${keyword}[${index}]`);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };

  return visit(start, []);
}

export const noComplexQueryParams: RuleDefinition = {
  name: 'no-complex-query-params',
  sourceRules: ['fern-definition/no-complex-query-params'],
  severity: 'error',
  description: 'Query parameter schemas must not contain discriminated unions.',
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        const reported = new Set<string>();
        for (const operation of getOperations(ctx, rootOf(root, ctx))) {
          for (const parameter of operation.parameters) {
            if (parameter.in !== 'query' || parameter.node.schema === undefined) {
              continue;
            }
            const schemaLocation = parameter.location.child('schema');
            const reportKey = schemaLocation.absolutePointer;
            if (reported.has(reportKey)) {
              continue;
            }
            const found = findDiscriminatedUnion(ctx, { node: parameter.node.schema, location: schemaLocation });
            if (found === undefined) {
              continue;
            }
            reported.add(reportKey);
            const union =
              found.name === undefined ? 'an inline discriminated union' : `the discriminated union "${found.name}"`;
            const relation =
              found.path.length === 0 ? `is ${union}` : `contains ${union} (at ${found.path.join(' > ')})`;
            ctx.report({
              message: `\`in: query\` parameter "${parameter.name}" has a schema that ${relation}. Discriminated unions cannot be serialized as query strings.`,
              location: schemaLocation.key(),
            });
          }
        }
      },
    },
  }),
};
