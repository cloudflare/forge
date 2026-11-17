/**
 * Reports `components.schemas` entries that share a `title`. Fern only checks this when the
 * `title-as-schema-name` generators.yml setting is on (Fern then names schemas after their titles),
 * so enabling this rule means that setting is on.
 *
 * Redocly's `component-name-unique` with `strategy: title` only compares titles of schemas in
 * other files, not schemas defined in the same document.
 *
 * Options:
 * - `resolveSchemaCollisions` (boolean, default false): mirrors the `resolve-schema-collisions`
 *   generators.yml setting, which makes Fern rename colliding schemas. When true, the rule reports
 *   nothing.
 */
import { rootOf } from '../utils/document.ts';
import { isPlainObject, isRefNode, resolveChild, resolveNode } from '../utils/resolve.ts';
import type { AnyNode, RuleDefinition, UserContext } from '../utils/types.ts';

interface Options {
  resolveSchemaCollisions?: boolean;
}

export const noSchemaTitleCollisions: RuleDefinition = {
  name: 'no-schema-title-collisions',
  sourceRules: ['oss/no-schema-title-collisions'],
  severity: 'error',
  recommended: false,
  description: 'Component schemas must not share a title when Fern uses titles as schema names.',
  rule: (options: Options = {}) => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        if (options.resolveSchemaCollisions === true) {
          return;
        }
        const components = resolveChild(ctx, rootOf(root, ctx), 'components');
        const schemas = components === undefined ? undefined : resolveChild(ctx, components, 'schemas');
        if (schemas === undefined || !isPlainObject(schemas.node)) {
          return;
        }
        const titles = new Map<string, string>();
        for (const [schemaId, raw] of Object.entries(schemas.node)) {
          // A local `$ref` is an alias of another component, which has no title of its own.
          if (isRefNode(raw) && raw.$ref.startsWith('#')) {
            continue;
          }
          const schema = resolveNode(ctx, raw, schemas.location.child(schemaId));
          if (schema === undefined || !isPlainObject(schema.node)) {
            continue;
          }
          const title = schema.node.title;
          if (typeof title !== 'string' || title.trim() === '') {
            continue;
          }
          const existing = titles.get(title);
          if (existing === undefined) {
            titles.set(title, schemaId);
            continue;
          }
          ctx.report({
            message: `Schema title collision detected: Multiple schemas use title '${title}'. Schema '${schemaId}' conflicts with schema '${existing}', and Fern names schemas after their titles (title-as-schema-name). Change one of the titles, or set 'resolve-schema-collisions: true' in generators.yml (and resolveSchemaCollisions: true on this rule) to resolve collisions automatically.`,
            location: schema.location.child('title'),
          });
        }
      },
    },
  }),
};
