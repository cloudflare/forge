/**
 * Reports component schemas whose names normalize (via {@link toForgeWords}) to the same SDK type
 * identifier, and schema keys that have no letters or digits.
 *
 * A schema's effective name is `x-forge-model-name` when set (and non-empty), otherwise the
 * `components.schemas` key. Schemas marked `x-forge-skip: true` are ignored.
 */
import { rootOf } from '../utils/document.ts';
import { groupAndReport } from '../utils/collision.ts';
import { isPlainObject, resolveChild } from '../utils/resolve.ts';
import type { AnyNode, Location, RuleDefinition, UserContext } from '../utils/types.ts';
import { forgeWordsKey, toForgeWords } from '../utils/words.ts';

interface EffectiveSchema {
  key: string;
  effectiveName: string;
  words: string[];
  usingExtension: boolean;
  location: Location;
}

function schemaLabel(schema: EffectiveSchema): string {
  return schema.usingExtension
    ? `schema '${schema.key}' (x-forge-model-name: '${schema.effectiveName}')`
    : `schema '${schema.key}'`;
}

export const noConflictingSchemaNames: RuleDefinition = {
  name: 'no-conflicting-schema-names',
  sourceRules: ['fern-definition/no-duplicate-declarations'],
  severity: 'error',
  description:
    'Component schemas must not normalize to the same Forge identifier, and schema keys must have letters or digits.',
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        const rootLocated = rootOf(root, ctx);
        const components = resolveChild(ctx, rootLocated, 'components');
        if (components === undefined) {
          return;
        }
        const schemas = resolveChild(ctx, components, 'schemas');
        if (schemas === undefined || !isPlainObject(schemas.node)) {
          return;
        }
        const effective: EffectiveSchema[] = [];
        for (const key of Object.keys(schemas.node)) {
          const schemaLocation = schemas.location.child(key);
          const schema = schemas.node[key];
          if (!isPlainObject(schema) || schema['x-forge-skip'] === true) {
            continue;
          }
          const extensionValue = schema['x-forge-model-name'];
          const usingExtension = typeof extensionValue === 'string' && (extensionValue as string).length > 0;
          const effectiveName = usingExtension ? (extensionValue as string) : key;
          const words = toForgeWords(effectiveName);
          if (words.length === 0) {
            const field = usingExtension ? 'x-forge-model-name' : undefined;
            const location = field === undefined ? schemaLocation.key() : schemaLocation.child(field).key();
            ctx.report({
              message: usingExtension
                ? `Schema '${key}' has an x-forge-model-name '${effectiveName}' with no letters or digits.`
                : `Schema '${key}' has no letters or digits. Rename the schema or set x-forge-model-name to a valid SDK identifier.`,
              location,
            });
            continue;
          }
          effective.push({
            key,
            effectiveName,
            words,
            usingExtension,
            location: usingExtension ? schemaLocation.child('x-forge-model-name').key() : schemaLocation.key(),
          });
        }
        groupAndReport(
          effective,
          (schema) => forgeWordsKey(schema.effectiveName),
          (group) => {
            const normalized = group[0]!.words.join(' ');
            const labels = group.map(schemaLabel).join(', ');
            ctx.report({
              message: `Schemas ${labels} all normalize to '${normalized}' in generated SDK code, which collides. Rename one of them, set a distinct x-forge-model-name, or mark one \`x-forge-skip: true\`.`,
              location: group[group.length - 1]!.location,
            });
          },
        );
      },
    },
  }),
};
