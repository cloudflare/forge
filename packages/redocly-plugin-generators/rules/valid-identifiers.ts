/**
 * Reports `x-forge-method-name`, `x-forge-model-name`, `x-forge-property-name`, and
 * `x-forge-parameter-name` values that are not valid Forge identifiers.
 *
 * Forge identifier rule (`Name::new`): starts with a letter, letters and digits only
 * (`^[A-Za-z][A-Za-z0-9]*$`). Non-string values are also reported.
 *
 * - `x-forge-method-name` on operations and `x-forge-aliases[*]`.
 * - `x-forge-model-name`, `x-forge-property-name` on schemas.
 * - `x-forge-parameter-name` on parameter objects.
 */
import { getOperations, rootOf } from '../utils/document.ts';
import { isPlainObject } from '../utils/resolve.ts';
import type { AnyNode, Location, RuleDefinition, UserContext } from '../utils/types.ts';

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*$/;

function reportIfInvalid(ctx: UserContext, node: AnyNode, location: Location, key: string): void {
  if (!isPlainObject(node) || node[key] === undefined) {
    return;
  }
  const value = node[key];
  if (typeof value === 'string' && IDENTIFIER.test(value)) {
    return;
  }
  const description = typeof value === 'string' ? `"${value}"` : typeof value;
  ctx.report({
    message: `${key} must be a valid Forge identifier (starts with a letter, letters and digits only); got ${description}.`,
    location: location.child(key).key(),
  });
}

export const validIdentifiers: RuleDefinition = {
  name: 'valid-identifiers',
  vendor: 'forge',
  sourceRules: ['fern-definition/valid-field-names', 'fern-definition/valid-type-name'],
  severity: 'error',
  description: '`x-forge-*-name` extensions must be valid Forge identifiers.',
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        for (const operation of getOperations(ctx, rootOf(root, ctx))) {
          reportIfInvalid(ctx, operation.node, operation.location, 'x-forge-method-name');
          const aliases = operation.node['x-forge-aliases'];
          if (Array.isArray(aliases)) {
            aliases.forEach((alias, index) => {
              reportIfInvalid(ctx, alias, operation.location.child(['x-forge-aliases', index]), 'x-forge-method-name');
            });
          }
        }
      },
    },
    Schema(schema: AnyNode, ctx: UserContext) {
      reportIfInvalid(ctx, schema, ctx.location, 'x-forge-model-name');
      reportIfInvalid(ctx, schema, ctx.location, 'x-forge-property-name');
    },
    Parameter(parameter: AnyNode, ctx: UserContext) {
      reportIfInvalid(ctx, parameter, ctx.location, 'x-forge-parameter-name');
    },
  }),
};
