/**
 * Reports multipart request bodies whose `encoding.<property>.explode: true` targets a property
 * that is not an array. OAS encoding "explode" is only well-defined for arrays — serializing a
 * non-array property with explode:true produces undefined behavior.
 *
 * A property with `contentType: application/json` is JSON-encoded, not form-serialized, so
 * explode does not apply and is not reported.
 */
import { getOperations, rootOf, schemaOfMediaType } from '../utils/document.ts';
import { isPlainObject, resolveChild } from '../utils/resolve.ts';
import { collectProperties, nonNullType, unwrapSchema } from '../utils/schema.ts';
import { isMultipartMediaType } from '../utils/structure.ts';
import type { AnyNode, Located, RuleDefinition, UserContext } from '../utils/types.ts';

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
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        const reported = new Set<string>();
        for (const operation of getOperations(ctx, rootOf(root, ctx))) {
          const requestBody = resolveChild(ctx, { node: operation.node, location: operation.location }, 'requestBody');
          const content = requestBody === undefined ? undefined : resolveChild(ctx, requestBody, 'content');
          if (content === undefined || !isPlainObject(content.node)) {
            continue;
          }
          for (const mediaTypeKey of Object.keys(content.node)) {
            if (!isMultipartMediaType(mediaTypeKey)) {
              continue;
            }
            const mediaType = resolveChild(ctx, content, mediaTypeKey);
            if (mediaType === undefined) {
              continue;
            }
            const encoding = resolveChild(ctx, mediaType, 'encoding');
            if (encoding === undefined || !isPlainObject(encoding.node)) {
              continue;
            }
            const properties = new Map(
              collectProperties(ctx, schemaOfMediaType(mediaType)).map((property) => [property.key, property]),
            );
            for (const key of Object.keys(encoding.node)) {
              const entry = resolveChild(ctx, encoding, key);
              if (entry === undefined || !isPlainObject(entry.node) || entry.node.explode !== true) {
                continue;
              }
              if (entry.node.contentType === 'application/json') {
                continue;
              }
              const property = properties.get(key);
              if (property === undefined) {
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
                message: `Multipart property "${key}" has \`encoding.${key}.explode: true\`, so it must be an array, but its schema is ${type}.`,
                location: location.key(),
              });
            }
          }
        }
      },
    },
  }),
};
