/**
 * Reports `x-forge-skip`, `x-forge-hidden`, `x-forge-internal`, and `x-forge-sensitive` values
 * that are not boolean. Forge's parser requires these to deserialize as `bool`; a non-boolean
 * value fails import.
 *
 * - `x-forge-skip`, `x-forge-hidden`, `x-forge-internal` on operations and `x-forge-aliases[*]`.
 * - `x-forge-skip`, `x-forge-sensitive` on schemas (component schemas, properties, nested schemas).
 */
import { getOperations, rootOf } from '../utils/document.ts';
import { describeKind, forEachForgeTarget } from '../utils/extensions.ts';
import { isPlainObject } from '../utils/resolve.ts';
import type { AnyNode, Location, RuleDefinition, UserContext } from '../utils/types.ts';

const OPERATION_BOOLS = ['x-forge-skip', 'x-forge-hidden', 'x-forge-internal'] as const;
const SCHEMA_BOOLS = ['x-forge-skip', 'x-forge-sensitive'] as const;

function reportIfNotBool(ctx: UserContext, node: AnyNode, location: Location, keys: readonly string[]): void {
  if (!isPlainObject(node)) {
    return;
  }
  for (const key of keys) {
    if (node[key] === undefined) {
      continue;
    }
    if (typeof node[key] === 'boolean') {
      continue;
    }
    ctx.report({
      message: `${key} must be boolean; got ${describeKind(node[key])}.`,
      location: location.child(key).key(),
    });
  }
}

export const booleanExtensions: RuleDefinition = {
  name: 'boolean-extensions',
  vendor: 'forge',
  sourceRules: [],
  severity: 'error',
  description: '`x-forge-skip`/`-hidden`/`-internal`/`-sensitive` must be boolean.',
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        for (const operation of getOperations(ctx, rootOf(root, ctx))) {
          forEachForgeTarget(operation, (node, location) => reportIfNotBool(ctx, node, location, OPERATION_BOOLS));
        }
      },
    },
    Schema(schema: AnyNode, ctx: UserContext) {
      reportIfNotBool(ctx, schema, ctx.location, SCHEMA_BOOLS);
    },
  }),
};
