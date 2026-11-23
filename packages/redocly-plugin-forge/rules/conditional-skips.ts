/**
 * Validates `x-forge-skip` and `x-forge-only-for` on operations, `x-forge-aliases[*]`, and
 * schemas (component schemas, properties, nested schemas).
 *
 * - `x-forge-skip` must be a boolean or an array of non-empty strings (condition names).
 * - `x-forge-only-for` must be an array of non-empty strings (condition names).
 *
 * Forge's host applies these filters before plugins see the model, driven by the conditions
 * pinned on the CLI (`--conditions=name,...`). See RFC 0003.
 */
import { getOperations, rootOf } from '../utils/document.ts';
import { describeKind, forEachForgeTarget } from '../utils/extensions.ts';
import { isPlainObject } from '../utils/resolve.ts';
import type { AnyNode, Location, RuleDefinition, UserContext } from '../utils/types.ts';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function checkSkip(ctx: UserContext, node: AnyNode, location: Location): void {
  if (!isPlainObject(node) || node['x-forge-skip'] === undefined) {
    return;
  }
  const value = node['x-forge-skip'];
  if (typeof value === 'boolean') {
    return;
  }
  if (Array.isArray(value) && value.every(isNonEmptyString)) {
    return;
  }
  const detail = Array.isArray(value) ? 'array with non-string or empty elements' : describeKind(value);
  ctx.report({
    message: `x-forge-skip must be a boolean or an array of non-empty condition names; got ${detail}.`,
    location: location.child('x-forge-skip').key(),
  });
}

function checkOnlyFor(ctx: UserContext, node: AnyNode, location: Location): void {
  if (!isPlainObject(node) || node['x-forge-only-for'] === undefined) {
    return;
  }
  const value = node['x-forge-only-for'];
  if (Array.isArray(value) && value.every(isNonEmptyString)) {
    return;
  }
  const detail = Array.isArray(value) ? 'array with non-string or empty elements' : describeKind(value);
  ctx.report({
    message: `x-forge-only-for must be an array of non-empty condition names; got ${detail}.`,
    location: location.child('x-forge-only-for').key(),
  });
}

export const conditionalSkips: RuleDefinition = {
  name: 'conditional-skips',
  sourceRules: [],
  severity: 'error',
  description: '`x-forge-skip` and `x-forge-only-for` must take valid shapes (RFC 0003).',
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        for (const operation of getOperations(ctx, rootOf(root, ctx))) {
          forEachForgeTarget(operation, (node, location) => {
            checkSkip(ctx, node, location);
            checkOnlyFor(ctx, node, location);
          });
        }
      },
    },
    Schema(schema: AnyNode, ctx: UserContext) {
      checkSkip(ctx, schema, ctx.location);
      checkOnlyFor(ctx, schema, ctx.location);
    },
  }),
};
