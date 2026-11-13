/**
 * Reports `x-forge-group-name` values that aren't a Forge SDK group path.
 *
 * Accepted shapes:
 * - A string: treated as a dotted path. Each segment (split on `.`) must be a valid Forge
 *   identifier (letters, digits, `-`, `_`; starts with a letter or `_`; must contain at least one
 *   letter; must not end with `-`).
 * - A non-empty array of strings: each element is one segment, same identifier rule.
 *
 * Checked on operations and `x-forge-aliases[*]`.
 */
import { getOperations, rootOf } from '../utils/document.ts';
import { describeKind, FORGE_IDENTIFIER, forEachForgeTarget } from '../utils/extensions.ts';
import { isPlainObject } from '../utils/resolve.ts';
import type { AnyNode, Location, RuleDefinition, UserContext } from '../utils/types.ts';

function check(ctx: UserContext, node: AnyNode, location: Location): void {
  if (!isPlainObject(node) || node['x-forge-group-name'] === undefined) {
    return;
  }
  const value = node['x-forge-group-name'];
  const report = (reason: string) => {
    ctx.report({
      message: `x-forge-group-name ${reason}.`,
      location: location.child('x-forge-group-name').key(),
    });
  };
  let segments: string[];
  if (typeof value === 'string') {
    segments = value.split('.');
  } else if (Array.isArray(value)) {
    if (value.length === 0) {
      report('array must not be empty');
      return;
    }
    if (!value.every((segment) => typeof segment === 'string')) {
      report('array elements must all be strings');
      return;
    }
    segments = value;
  } else {
    report(`must be a string or array of strings; got ${describeKind(value)}`);
    return;
  }
  for (const segment of segments) {
    if (!FORGE_IDENTIFIER.test(segment)) {
      report(
        `segment "${segment}" is not a valid Forge identifier (letters, digits, '-', '_'; starts with a letter or '_'; must contain at least one letter; must not end with '-')`,
      );
      return;
    }
  }
}

export const validGroupName: RuleDefinition = {
  name: 'valid-group-name',
  vendor: 'forge',
  sourceRules: [],
  severity: 'error',
  description: '`x-forge-group-name` must be a dotted identifier path or array of identifier segments.',
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
