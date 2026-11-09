/**
 * Reports multipart request bodies whose `encoding.<property>.explode: true` targets a property
 * that is not an array. Fern imports such a property with the `exploded` style, which requires a
 * list. File properties are never exploded, and a part with `contentType: application/json`
 * (or, with the `defaultFormParameterEncoding` option, any part without a `contentType`) is
 * JSON/form encoded instead of exploded.
 *
 * Options:
 * - `defaultFormParameterEncoding`: `"form"` or `"json"`, mirroring the Fern generator option of
 *   the same name. When set, parts without an explicit `contentType` are not exploded.
 */
import { getOperations, rootOf, schemaOfMediaType } from '../utils/document.ts';
import { isPlainObject, resolveChild } from '../utils/resolve.ts';
import { collectProperties, nonNullType, unwrapSchema } from '../utils/schema.ts';
import { fernRequestMediaTypes, isFernEndpoint, isFileSchema } from '../utils/structure.ts';
import type { AnyNode, Located, RuleDefinition, UserContext } from '../utils/types.ts';

interface Options {
  defaultFormParameterEncoding?: unknown;
}

function describeType(ctx: UserContext, schema: Located): string {
  const resolved = unwrapSchema(ctx, schema);
  const type = nonNullType(resolved?.node);
  const withArticle = (word: string) => `${/^[aeiou]/.test(word) ? 'an' : 'a'} ${word}`;
  if (type !== undefined) {
    return withArticle(type);
  }
  if (isPlainObject(resolved?.node) && isPlainObject(resolved.node.properties)) {
    return 'an object';
  }
  return 'not an array';
}

export const explodedFormDataIsArray: RuleDefinition = {
  name: 'exploded-form-data-is-array',
  sourceRules: ['fern-definition/exploded-form-data-is-array'],
  severity: 'error',
  description: 'Multipart properties with `encoding.explode: true` must be arrays.',
  rule: (options: Options = {}) => {
    const hasDefaultEncoding =
      options.defaultFormParameterEncoding === 'form' || options.defaultFormParameterEncoding === 'json';
    return {
      Root: {
        leave(root: AnyNode, ctx: UserContext) {
          const reported = new Set<string>();
          for (const operation of getOperations(ctx, rootOf(root, ctx))) {
            if (!isFernEndpoint(operation)) {
              continue;
            }
            for (const mediaType of fernRequestMediaTypes(ctx, operation)) {
              if (mediaType.kind !== 'multipart') {
                continue;
              }
              const encoding = resolveChild(ctx, mediaType, 'encoding');
              if (encoding === undefined || !isPlainObject(encoding.node)) {
                continue;
              }
              const properties = collectProperties(ctx, schemaOfMediaType(mediaType)).filter(
                (property) => !property.inherited,
              );
              for (const key of Object.keys(encoding.node)) {
                const entry = resolveChild(ctx, encoding, key);
                if (entry === undefined || !isPlainObject(entry.node) || entry.node.explode !== true) {
                  continue;
                }
                const contentType = entry.node.contentType;
                if (contentType === 'application/json' || (contentType === undefined && hasDefaultEncoding)) {
                  continue;
                }
                const property = properties.find((candidate) => candidate.key === key);
                if (property === undefined || isFileSchema(property.schema.node)) {
                  continue;
                }
                const resolved = unwrapSchema(ctx, property.schema);
                if (nonNullType(resolved?.node) === 'array') {
                  continue;
                }
                const location = entry.location.child('explode');
                if (reported.has(location.absolutePointer)) {
                  continue;
                }
                reported.add(location.absolutePointer);
                const type = describeType(ctx, property.schema);
                ctx.report({
                  message: `Multipart property "${key}" has \`encoding.${key}.explode: true\`, so it must be an array, but its schema is ${type}. Did you mean \`type: array\` with \`items\` of the current schema?`,
                  location: location.key(),
                });
              }
            }
          }
        },
      },
    };
  },
};
