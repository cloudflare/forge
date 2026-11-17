/**
 * Validates `x-fern-base-path` (a string, or `{path, parameters?, paths-include-base-path?}`):
 * the base path must be empty or start with a slash, and with `paths-include-base-path: true`
 * every path must start with the base path so Fern can strip it.
 */
import { rootOf } from '../utils/document.ts';
import { describeValue } from '../utils/extensions.ts';
import { readBasePath } from '../utils/extensions-base-path.ts';
import { isPlainObject, resolveChild } from '../utils/resolve.ts';
import type { AnyNode, RuleDefinition, UserContext } from '../utils/types.ts';

export const validBasePath: RuleDefinition = {
  name: 'valid-base-path',
  sourceRules: ['fern-definition/valid-base-path'],
  severity: 'error',
  description:
    'x-fern-base-path is well formed, starts with a slash, and prefixes every path when paths-include-base-path is set.',
  rule: () => ({
    Root: {
      leave(rootNode: AnyNode, ctx: UserContext) {
        const root = rootOf(rootNode, ctx);
        const basePath = readBasePath(ctx, root);
        if (basePath === undefined) {
          return;
        }
        if (basePath.form === 'invalid') {
          ctx.report({
            message: `x-fern-base-path must be a string such as '/v1', or an object with a \`path\`; Fern ignores ${describeValue(basePath.value.node)}.`,
            location: basePath.value.location,
          });
          return;
        }
        const { path } = basePath;
        if (path === undefined) {
          ctx.report({
            message: 'x-fern-base-path must specify a `path` string; Fern ignores the base path without one.',
            location: basePath.value.node.path === undefined ? basePath.pathLocation.key() : basePath.pathLocation,
          });
        } else if (path.length > 0 && !path.startsWith('/')) {
          ctx.report({
            message: `x-fern-base-path must be empty or start with a slash; Fern ignores '${path}'.`,
            location: basePath.pathLocation,
          });
        }
        if (basePath.parameters !== undefined && !isPlainObject(basePath.parameters.node)) {
          ctx.report({
            message:
              'x-fern-base-path `parameters` must be an object keyed by path parameter name; Fern ignores this value and declares the `{placeholders}` of `path` as plain string parameters without docs or defaults.',
            location: basePath.parameters.location,
            forceSeverity: 'warn',
          });
        }
        const include = basePath.pathsIncludeBasePath;
        if (include !== undefined && include !== null && typeof include !== 'boolean') {
          ctx.report({
            message: `x-fern-base-path \`paths-include-base-path\` must be a boolean; Fern treats ${describeValue(include)} as false, so it does not strip the base path from the paths and prepends it to them again (a path that already includes it gets it twice).`,
            location: basePath.value.location.child(['paths-include-base-path']),
          });
        }
        if (include !== true || path === undefined || !path.startsWith('/')) {
          return;
        }

        const prefix = path.endsWith('/') ? path.slice(0, -1) : path;
        const paths = resolveChild(ctx, root, 'paths');
        if (prefix.length === 0 || paths === undefined || !isPlainObject(paths.node)) {
          return;
        }
        for (const key of Object.keys(paths.node)) {
          if (key.startsWith('x-')) {
            continue;
          }
          const location = paths.location.child([key]).key();
          if (!key.startsWith(prefix)) {
            ctx.report({
              message: `Expected path '${key}' to start with base path '${prefix}' (x-fern-base-path sets paths-include-base-path: true). Fern leaves this path unchanged and still prepends the base path, so SDKs call '${prefix}${key}'.`,
              location,
              forceSeverity: 'warn',
            });
            continue;
          }
          const rest = key.slice(prefix.length);
          if (rest.length > 0 && !rest.startsWith('/')) {
            const consequence = prefix.includes('{')
              ? `produces the path '${rest}', and fern check fails with "Path must start with a slash"`
              : `prepends the base path again with a slash, so SDKs call '${prefix}/${rest}' instead of '${key}'`;
            ctx.report({
              message: `Path '${key}' starts with base path '${prefix}' only partway through a segment. Fern strips the prefix anyway and ${consequence}.`,
              location,
            });
          }
        }
      },
    },
  }),
};
