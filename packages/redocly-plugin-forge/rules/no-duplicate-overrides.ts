/**
 * Reports pairs of operations that resolve to the same `(group, method)` SDK coordinate.
 *
 * An operation contributes to the check when it has both `x-forge-method-name` and
 * `x-forge-group-name`, and `x-forge-skip` is not `true`. The group key is the dotted path for a
 * string, or the elements joined with `.` for an array. Operations whose group or method is
 * malformed are ignored (other rules report those).
 */
import { getOperations, type OperationInfo, operationLabel, rootOf } from '../utils/document.ts';
import { dottedGroupKey } from '../utils/extensions.ts';
import { isPlainObject } from '../utils/resolve.ts';
import type { AnyNode, Location, RuleDefinition, UserContext } from '../utils/types.ts';

interface Override {
  group: string;
  method: string;
  location: Location;
  operation: OperationInfo;
}

function extractOverride(operation: OperationInfo): Override | undefined {
  if (!isPlainObject(operation.node) || operation.node['x-forge-skip'] === true) {
    return undefined;
  }
  const method = operation.node['x-forge-method-name'];
  const group = dottedGroupKey(operation.node['x-forge-group-name']);
  if (typeof method !== 'string' || group === undefined) {
    return undefined;
  }
  return { group, method, location: operation.location.child('x-forge-method-name').key(), operation };
}

export const noDuplicateOverrides: RuleDefinition = {
  name: 'no-duplicate-overrides',
  vendor: 'forge',
  sourceRules: ['oss/no-duplicate-overrides'],
  severity: 'error',
  description: 'Operations must not share the same `(x-forge-group-name, x-forge-method-name)`.',
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        const seen = new Map<string, Override>();
        for (const operation of getOperations(ctx, rootOf(root, ctx))) {
          const override = extractOverride(operation);
          if (override === undefined) {
            continue;
          }
          const key = `${override.group}\u0000${override.method}`;
          const existing = seen.get(key);
          if (existing === undefined) {
            seen.set(key, override);
            continue;
          }
          const coordinate = override.group === '' ? override.method : `${override.group}.${override.method}`;
          ctx.report({
            message:
              `SDK method "${coordinate}" already defined by ${operationLabel(existing.operation)}. ` +
              `Change x-forge-group-name or x-forge-method-name on one of the operations.`,
            location: override.location,
          });
        }
      },
    },
  }),
};
