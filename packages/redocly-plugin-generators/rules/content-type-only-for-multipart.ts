/**
 * Reports `encoding.<property>.contentType` on request bodies that Fern does not import as
 * multipart. Fern only reads per-property content types for `multipart/*` request bodies and
 * ignores them on form-urlencoded, JSON and other request bodies.
 */
import { getOperations, rootOf } from '../utils/document.ts';
import { isPlainObject, resolveChild } from '../utils/resolve.ts';
import { fernRequestMediaTypes, isFernEndpoint } from '../utils/structure.ts';
import type { AnyNode, RuleDefinition, UserContext } from '../utils/types.ts';

export const contentTypeOnlyForMultipart: RuleDefinition = {
  name: 'content-type-only-for-multipart',
  sourceRules: ['fern-definition/content-type-only-for-multipart'],
  severity: 'error',
  description: 'Per-property `encoding.contentType` is only supported on multipart request bodies.',
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        const reported = new Set<string>();
        for (const operation of getOperations(ctx, rootOf(root, ctx))) {
          if (!isFernEndpoint(operation)) {
            continue;
          }
          for (const mediaType of fernRequestMediaTypes(ctx, operation)) {
            if (mediaType.kind === 'multipart') {
              continue;
            }
            const encoding = resolveChild(ctx, mediaType, 'encoding');
            if (encoding === undefined || !isPlainObject(encoding.node)) {
              continue;
            }
            for (const key of Object.keys(encoding.node)) {
              const entry = resolveChild(ctx, encoding, key);
              if (entry === undefined || !isPlainObject(entry.node) || entry.node.contentType === undefined) {
                continue;
              }
              const location = entry.location.child('contentType');
              if (reported.has(location.absolutePointer)) {
                continue;
              }
              reported.add(location.absolutePointer);
              ctx.report({
                message: `Property "${key}" has \`encoding.${key}.contentType\`, but the request body is \`${mediaType.mediaType}\`, not multipart. Fern only applies per-property content types to multipart/form-data request bodies and ignores this one.`,
                location: location.key(),
              });
            }
          }
        }
      },
    },
  }),
};
