/**
 * Reports malformed `x-forge-aliases` arrays and duplicate `(group, method)` combinations
 * within an operation's alias list.
 *
 * - `x-forge-aliases` must be a non-empty array of objects.
 * - Each alias must declare `x-forge-method-name` (otherwise it has no effect).
 * - No two aliases in the same list may share the same `(group, method)` pair. Group is the
 *   alias's declared `x-forge-group-name` (dotted string or joined array); undeclared counts as
 *   its own bucket. Different group values produce different buckets.
 */
import { getOperations, rootOf } from '../utils/document.ts';
import { dottedGroupKey } from '../utils/extensions.ts';
import { isPlainObject } from '../utils/resolve.ts';
import type { AnyNode, Location, RuleDefinition, UserContext } from '../utils/types.ts';

export const validAliases: RuleDefinition = {
  name: 'valid-aliases',
  vendor: 'forge',
  sourceRules: [],
  severity: 'error',
  description: '`x-forge-aliases` must be a non-empty array of alias objects with unique `(group, method)` pairs.',
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        for (const operation of getOperations(ctx, rootOf(root, ctx))) {
          const aliases = operation.node['x-forge-aliases'];
          if (aliases === undefined) {
            continue;
          }
          const aliasesLocation = operation.location.child('x-forge-aliases');
          if (!Array.isArray(aliases)) {
            ctx.report({
              message: `x-forge-aliases must be an array; got ${typeof aliases}.`,
              location: aliasesLocation.key(),
            });
            continue;
          }
          if (aliases.length === 0) {
            ctx.report({
              message: 'x-forge-aliases must not be empty.',
              location: aliasesLocation.key(),
            });
            continue;
          }
          const seen = new Map<string, Location>();
          aliases.forEach((alias: AnyNode, index: number) => {
            const aliasLocation = aliasesLocation.child(index);
            if (!isPlainObject(alias)) {
              ctx.report({
                message: `x-forge-aliases[${index}] must be an object; got ${typeof alias}.`,
                location: aliasLocation.key(),
              });
              return;
            }
            const method = alias['x-forge-method-name'];
            if (typeof method !== 'string') {
              ctx.report({
                message: `x-forge-aliases[${index}] must declare x-forge-method-name.`,
                location: aliasLocation.key(),
              });
              return;
            }
            const group = dottedGroupKey(alias['x-forge-group-name']) ?? '';
            const key = `${group}\u0000${method}`;
            if (seen.has(key)) {
              const coordinate = group === '' ? `"${method}"` : `"${group}.${method}"`;
              ctx.report({
                message: `x-forge-aliases[${index}] has the same (group, method) ${coordinate} as an earlier alias.`,
                location: aliasLocation.child('x-forge-method-name').key(),
              });
              return;
            }
            seen.set(key, aliasLocation);
          });
        }
      },
    },
  }),
};
