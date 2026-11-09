/**
 * Validates `x-fern-version`, the API version header declaration Fern turns into an enum:
 * `header` and `values` are required and well formed (fern check accepts malformed shapes, but SDK
 * generation then fails), values are unique, and `default` is one of the values.
 */
import { rootOf } from '../utils/document.ts';
import { describeValue, isNonEmptyString } from '../utils/extensions.ts';
import { rootValue } from '../utils/extensions-servers.ts';
import { isPlainObject } from '../utils/resolve.ts';
import type { AnyNode, RuleDefinition, UserContext } from '../utils/types.ts';

export const validVersion: RuleDefinition = {
  name: 'valid-version',
  sourceRules: ['fern-definition/valid-version'],
  severity: 'error',
  description: 'x-fern-version declares a header, a list of unique values, and a default that is one of them.',
  rule: () => ({
    Root: {
      leave(rootNode: AnyNode, ctx: UserContext) {
        const root = rootOf(rootNode, ctx);
        const version = rootValue(ctx, root, 'x-fern-version');
        if (version === undefined) {
          return;
        }
        if (!isPlainObject(version.node)) {
          ctx.report({
            message:
              'x-fern-version must be an object with a `header` and a list of `values`. fern check does not catch this, but SDK generation fails.',
            location: version.location,
          });
          return;
        }
        const { header, values } = version.node;
        if (header === undefined || header === null) {
          ctx.report({
            message:
              'x-fern-version must specify the `header` that carries the version. fern check does not catch this, but SDK generation fails.',
            location: version.location.child(['header']).key(),
          });
        } else if (!isNonEmptyString(header) && !(isPlainObject(header) && isNonEmptyString(header.value))) {
          ctx.report({
            message:
              'x-fern-version `header` must be a header name, or an object whose `value` is the header name. fern check does not catch this, but SDK generation fails.',
            location: isPlainObject(header)
              ? version.location.child(['header', 'value'])
              : version.location.child(['header']),
          });
        }

        if (!Array.isArray(values)) {
          ctx.report({
            message: `x-fern-version must list the allowed versions in \`values\`. ${values === undefined || values === null ? 'Fern crashes while reading the document.' : 'fern check does not catch this, but SDK generation fails.'}`,
            location:
              values === undefined ? version.location.child(['values']).key() : version.location.child(['values']),
          });
          return;
        }
        const seen = new Set<string>();
        values.forEach((entry: AnyNode, index: number) => {
          const location = version.location.child(['values', index]);
          const value =
            typeof entry === 'string'
              ? entry
              : isPlainObject(entry) && typeof entry.value === 'string'
                ? entry.value
                : undefined;
          if (value === undefined) {
            ctx.report({
              message:
                'x-fern-version values must be strings, or objects with a string `value`. fern check does not catch this, but SDK generation fails.',
              location: isPlainObject(entry) ? location.child(['value']) : location,
            });
            return;
          }
          if (seen.has(value)) {
            ctx.report({
              message: `Version "${value}" is listed more than once in x-fern-version values. Fern generates the version enum with a member per entry, so two members share the value "${value}" (duplicated values are rejected in every other Fern enum).`,
              location,
            });
          }
          seen.add(value);
        });

        const defaultVersion = version.node.default;
        if (
          defaultVersion !== undefined &&
          defaultVersion !== null &&
          (typeof defaultVersion !== 'string' || !seen.has(defaultVersion))
        ) {
          ctx.report({
            message: `Default version ${typeof defaultVersion === 'string' ? `"${defaultVersion}"` : describeValue(defaultVersion)} not found in x-fern-version values`,
            location: version.location.child(['default']),
          });
        }
      },
    },
  }),
};
