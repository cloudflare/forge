/**
 * Reports `x-forge-method-name`, `x-forge-model-name`, `x-forge-property-name`, and
 * `x-forge-parameter-name` values that are not valid Forge identifiers.
 *
 * Accepts letters, digits, `-`, and `_`; must start with a letter or `_`, must contain at least
 * one letter, and must not end with `-`. This covers kebab-case, camelCase, snake_case,
 * SCREAMING_SNAKE_CASE, trailing digits or underscores, a leading underscore, and the `_<digit>`
 * form Forge emits when escaping names that would otherwise start with a digit. Non-string values
 * are also reported.
 *
 * Narrower than what Forge's `Name::new` parser accepts (which tolerates any non-alphanumeric as a
 * word separator) because the lint's job is to catch likely typos — `list.all` is almost always a
 * mistake for `list-all` — without blocking idiomatic forms.
 *
 * Case conventions per kind (model vs method vs property) are intentionally not enforced: Forge
 * normalizes casing per target language, so the author's casing is only a hint. Collisions between
 * two `x-forge-method-name`s in the same group, or two `x-forge-property-name`s in the same
 * schema, are a separate concern and belong in their own rules.
 *
 * - `x-forge-method-name` on operations and `x-forge-aliases[*]`.
 * - `x-forge-model-name`, `x-forge-property-name` on schemas.
 * - `x-forge-parameter-name` on parameter objects.
 */
import { getOperations, rootOf } from '../utils/document.ts';
import { describeKind, FORGE_IDENTIFIER, forEachForgeTarget } from '../utils/extensions.ts';
import { isPlainObject } from '../utils/resolve.ts';
import type { AnyNode, Location, RuleDefinition, UserContext } from '../utils/types.ts';

function reportIfInvalid(ctx: UserContext, node: AnyNode, location: Location, key: string): void {
  if (!isPlainObject(node) || node[key] === undefined) {
    return;
  }
  const value = node[key];
  if (typeof value === 'string' && FORGE_IDENTIFIER.test(value)) {
    return;
  }
  const description = typeof value === 'string' ? `"${value}"` : describeKind(value);
  ctx.report({
    message: `${key} must be a valid Forge identifier (letters, digits, '-', '_'; starts with a letter or '_'; must not end with '-'; must contain at least one letter); got ${description}.`,
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
          forEachForgeTarget(operation, (node, location) =>
            reportIfInvalid(ctx, node, location, 'x-forge-method-name'),
          );
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
