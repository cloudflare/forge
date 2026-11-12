/**
 * Reports `x-forge-availability` values that are not one of the five Forge availability stages.
 * Checks operations and `x-forge-aliases[*]` elements.
 */
import { getOperations, rootOf } from '../utils/document.ts';
import { forEachForgeTarget } from '../utils/extensions.ts';
import { isPlainObject } from '../utils/resolve.ts';
import type { AnyNode, Location, RuleDefinition, UserContext } from '../utils/types.ts';

const ALLOWED = ['alpha', 'beta', 'preview', 'generally-available', 'deprecated'] as const;

function check(ctx: UserContext, node: AnyNode, location: Location): void {
  if (!isPlainObject(node) || node['x-forge-availability'] === undefined) {
    return;
  }
  const value = node['x-forge-availability'];
  if (typeof value === 'string' && (ALLOWED as readonly string[]).includes(value)) {
    return;
  }
  const description = typeof value === 'string' ? `"${value}"` : typeof value;
  ctx.report({
    message: `x-forge-availability must be one of ${ALLOWED.join(', ')}; got ${description}.`,
    location: location.child('x-forge-availability').key(),
  });
}

export const validAvailability: RuleDefinition = {
  name: 'valid-availability',
  vendor: 'forge',
  sourceRules: [],
  severity: 'error',
  description: '`x-forge-availability` must be a recognized Forge availability stage.',
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        for (const operation of getOperations(ctx, rootOf(root, ctx))) {
          forEachForgeTarget(operation, (node, location) => check(ctx, node, location));
        }
      },
    },
  }),
};
