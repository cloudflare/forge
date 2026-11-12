/**
 * Reports `encoding.<property>.contentType` on non-multipart request bodies. Per OAS 3.x §4.8.24.1
 * (Encoding Object), `contentType` is only meaningful for `multipart/*` request bodies.
 *
 * Generators that honor the Encoding Object use `contentType` to pick a per-part serializer when
 * assembling a multipart message; on any other media type (`application/x-www-form-urlencoded`,
 * `application/json`, ...) the field has no defined effect and is silently ignored, so an author
 * who set it expecting it to take effect gets wrong wire output. Move the property into a
 * multipart body, or drop the per-property `contentType`.
 */
import { getOperations, getRequestBodyContent, rootOf } from '../utils/document.ts';
import { isPlainObject, resolveChild } from '../utils/resolve.ts';
import { isMultipartMediaType } from '../utils/structure.ts';
import type { AnyNode, RuleDefinition, UserContext } from '../utils/types.ts';

export const contentTypeOnlyForMultipart: RuleDefinition = {
  name: 'content-type-only-for-multipart',
  sourceRules: ['fern-definition/content-type-only-for-multipart'],
  severity: 'error',
  description: 'Per-property `encoding.contentType` is only meaningful on multipart request bodies.',
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        const reported = new Set<string>();
        for (const operation of getOperations(ctx, rootOf(root, ctx))) {
          const content = getRequestBodyContent(ctx, operation);
          if (content === undefined) {
            continue;
          }
          for (const mediaType of Object.keys(content.node)) {
            if (isMultipartMediaType(mediaType)) {
              continue;
            }
            const entry = resolveChild(ctx, content, mediaType);
            const encoding = entry === undefined ? undefined : resolveChild(ctx, entry, 'encoding');
            if (encoding === undefined || !isPlainObject(encoding.node)) {
              continue;
            }
            for (const key of Object.keys(encoding.node)) {
              const property = resolveChild(ctx, encoding, key);
              if (property === undefined || !isPlainObject(property.node) || property.node.contentType === undefined) {
                continue;
              }
              const location = property.location.child('contentType');
              if (reported.has(location.absolutePointer)) {
                continue;
              }
              reported.add(location.absolutePointer);
              ctx.report({
                message: `Property "${key}" sets \`encoding.${key}.contentType\`, but the request body is \`${mediaType}\`, not multipart. Per-property \`contentType\` is only meaningful for multipart request bodies (OAS 3.x §4.8.24.1).`,
                location: location.key(),
              });
            }
          }
        }
      },
    },
  }),
};
