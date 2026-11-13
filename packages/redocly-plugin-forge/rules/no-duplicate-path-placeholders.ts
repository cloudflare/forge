/**
 * Reports path templates that use the same path parameter placeholder more than once (e.g.
 * `/pets/{id}/toys/{id}`).
 *
 * The OpenAPI path-parameter model maps each distinct placeholder to one `Parameter` object;
 * repeating a placeholder leaves the two slots indistinguishable, so SDK generators either emit
 * a single argument that is silently bound to both positions or fail with an ambiguous-binding
 * error. Rename one of the placeholders (e.g. `/pets/{petId}/toys/{toyId}`).
 *
 * Redocly's built-in `path-params-defined` catches placeholders missing a declaration and
 * declarations missing a placeholder, but not this case.
 */
import { rootOf } from '../utils/document.ts';
import { duplicatePlaceholders } from '../utils/extensions.ts';
import { isPlainObject, resolveChild } from '../utils/resolve.ts';
import type { AnyNode, RuleDefinition, UserContext } from '../utils/types.ts';

export const noDuplicatePathPlaceholders: RuleDefinition = {
  name: 'no-duplicate-path-placeholders',
  sourceRules: ['fern-definition/no-undefined-path-parameters'],
  severity: 'error',
  description: 'Path templates must not use the same path parameter placeholder more than once.',
  rule: () => ({
    Root: {
      leave(rootNode: AnyNode, ctx: UserContext) {
        const root = rootOf(rootNode, ctx);
        const paths = resolveChild(ctx, root, 'paths');
        if (paths === undefined || !isPlainObject(paths.node)) {
          return;
        }
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
      },
    },
  }),
};
