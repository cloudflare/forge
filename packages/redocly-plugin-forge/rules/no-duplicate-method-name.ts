/**
 * Reports operations (and their `x-forge-aliases`) that resolve to the same `(group, method)` SDK
 * coordinate after Forge-identifier normalization.
 *
 * A target contributes to the check when it has both `x-forge-method-name` and
 * `x-forge-group-name`, and `x-forge-skip` is not `true`. An alias inherits its operation's
 * `x-forge-group-name` when the alias does not declare its own. The group key is the dotted path
 * for a string, or the elements joined with `.` for an array; both are then normalized with
 * {@link toForgeWords} so `listZones`, `list_zones`, and `LIST-ZONES` all collide. Targets whose
 * group or method is malformed are ignored (other rules report those).
 */
import { getOperations, type OperationInfo, operationLabel, rootOf } from '../utils/document.ts';
import { dottedGroupKey } from '../utils/extensions.ts';
import { isPlainObject } from '../utils/resolve.ts';
import type { AnyNode, Location, RuleDefinition, UserContext } from '../utils/types.ts';
import { forgeWordsKey, toForgeWords } from '../utils/words.ts';

interface Target {
  /** Normalized key for dedup: group words then method words, separated by a sentinel. */
  key: string;
  /** Human-readable coordinate, e.g. `zones.list`. */
  coordinate: string;
  /** Report location on the method-name field. */
  location: Location;
  operation: OperationInfo;
}

function normalizedGroupKey(group: string): string {
  return group.split('.').map(forgeWordsKey).join('\u0001');
}

function extractTarget(
  node: AnyNode,
  location: Location,
  operation: OperationInfo,
  fallbackGroup: unknown,
): Target | undefined {
  if (!isPlainObject(node) || node['x-forge-skip'] === true) {
    return undefined;
  }
  const method = node['x-forge-method-name'];
  const group = dottedGroupKey(node['x-forge-group-name'] ?? fallbackGroup);
  if (typeof method !== 'string' || group === undefined) {
    return undefined;
  }
  if (toForgeWords(method).length === 0) {
    return undefined;
  }
  const groupSegments = group === '' ? [] : group.split('.');
  if (groupSegments.some((segment) => toForgeWords(segment).length === 0)) {
    return undefined;
  }
  const key = `${normalizedGroupKey(group)}\u0000${forgeWordsKey(method)}`;
  const coordinate = group === '' ? method : `${group}.${method}`;
  return { key, coordinate, location: location.child('x-forge-method-name').key(), operation };
}

function* targetsOfOperation(operation: OperationInfo): Iterable<Target> {
  if (!isPlainObject(operation.node) || operation.node['x-forge-skip'] === true) {
    return;
  }
  const operationGroup = operation.node['x-forge-group-name'];
  const operationTarget = extractTarget(operation.node, operation.location, operation, undefined);
  if (operationTarget !== undefined) {
    yield operationTarget;
  }
  const aliases = operation.node['x-forge-aliases'];
  if (!Array.isArray(aliases)) {
    return;
  }
  for (const [index, alias] of aliases.entries()) {
    const aliasLocation = operation.location.child(['x-forge-aliases', index]);
    const target = extractTarget(alias, aliasLocation, operation, operationGroup);
    if (target !== undefined) {
      yield target;
    }
  }
}

export const noDuplicateMethodName: RuleDefinition = {
  name: 'no-duplicate-method-name',
  sourceRules: ['fern-definition/no-duplicate-overrides'],
  severity: 'error',
  description:
    'Operations and `x-forge-aliases` must not share the same `(x-forge-group-name, x-forge-method-name)` after Forge-identifier normalization.',
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        const seen = new Map<string, Target>();
        for (const operation of getOperations(ctx, rootOf(root, ctx))) {
          for (const target of targetsOfOperation(operation)) {
            const existing = seen.get(target.key);
            if (existing === undefined) {
              seen.set(target.key, target);
              continue;
            }
            ctx.report({
              message:
                `SDK method "${target.coordinate}" already defined by ${operationLabel(existing.operation)} ` +
                `(as "${existing.coordinate}"). Change x-forge-group-name or x-forge-method-name on one of them.`,
              location: target.location,
            });
          }
        }
      },
    },
  }),
};
