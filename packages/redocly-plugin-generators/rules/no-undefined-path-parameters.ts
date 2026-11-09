/**
 * Path parameter checks Redocly's `path-params-defined` does not cover: repeated placeholders in
 * a path template, and the path parameters of `x-fern-base-path` (repeated placeholders,
 * placeholders in the string form, which declares no parameters, and `parameters` entries the
 * base path never references).
 */
import { rootOf } from '../utils/document.ts';
import { duplicatePlaceholders, pathPlaceholders } from '../utils/extensions.ts';
import { readBasePath } from '../utils/extensions-base-path.ts';
import { isPlainObject, resolveChild } from '../utils/resolve.ts';
import type { AnyNode, RuleDefinition, UserContext } from '../utils/types.ts';

export const noUndefinedPathParameters: RuleDefinition = {
  name: 'no-undefined-path-parameters',
  vendor: 'fern',
  sourceRules: ['fern-definition/no-undefined-path-parameters'],
  severity: 'error',
  description:
    'Path templates and x-fern-base-path reference each path parameter once, and every base path parameter is used.',
  rule: () => ({
    Root: {
      leave(rootNode: AnyNode, ctx: UserContext) {
        const root = rootOf(rootNode, ctx);
        const paths = resolveChild(ctx, root, 'paths');
        if (paths !== undefined && isPlainObject(paths.node)) {
          for (const path of Object.keys(paths.node)) {
            if (path.startsWith('x-')) {
              continue;
            }
            for (const name of duplicatePlaceholders(path)) {
              ctx.report({
                message: `Path '${path}' has duplicate path parameter: ${name}.`,
                location: paths.location.child([path]).key(),
              });
            }
          }
        }

        const basePath = readBasePath(ctx, root);
        if (basePath?.path === undefined || !basePath.path.startsWith('/')) {
          return;
        }
        const { path } = basePath;
        for (const name of duplicatePlaceholders(path)) {
          ctx.report({
            message: `x-fern-base-path '${path}' has duplicate path parameter: ${name}.`,
            location: basePath.pathLocation,
          });
        }
        const placeholders = new Set(pathPlaceholders(path));
        if (basePath.form === 'string') {
          for (const name of placeholders) {
            ctx.report({
              message: `x-fern-base-path has missing path parameter: ${name}. The string form declares no path parameters; use the object form (path and parameters) to declare '${name}'.`,
              location: basePath.pathLocation,
            });
          }
          return;
        }
        const parameters = basePath.parameters;
        if (parameters === undefined || !isPlainObject(parameters.node)) {
          return;
        }
        for (const name of Object.keys(parameters.node)) {
          if (!placeholders.has(name)) {
            ctx.report({
              message: `Path parameter is unreferenced in x-fern-base-path '${path}': ${name}. Fern ignores it.`,
              location: parameters.location.child([name]).key(),
              forceSeverity: 'warn',
            });
          }
        }
      },
    },
  }),
};
