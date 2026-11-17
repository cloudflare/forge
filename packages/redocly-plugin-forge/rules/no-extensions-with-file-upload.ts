/**
 * Reports multipart request body schemas that inherit from another schema through an `allOf`
 * `$ref` member. Fern imports multipart (file upload) requests from the schema's own properties
 * only: a `$ref` member becomes an `extends` that file upload requests do not support, so the
 * inherited properties are dropped. `$ref`s to `oneOf`/`anyOf` schemas are exempt because Fern
 * inlines their variants' properties.
 */
import { getOperations, rootOf, schemaOfMediaType } from '../utils/document.ts';
import { isPlainObject, isRefNode, resolveNode } from '../utils/resolve.ts';
import { refName } from '../utils/schema.ts';
import { allOfAliasTarget, convertsToObject, fernRequestMediaTypes, isFernEndpoint } from '../utils/structure.ts';
import type { AnyNode, Located, RuleDefinition, UserContext } from '../utils/types.ts';

/** `allOf` `$ref` members of the multipart schema that Fern drops. */
function droppedParents(ctx: UserContext, schema: Located): Located[] {
  let current = resolveNode(ctx, schema.node, schema.location);
  for (let depth = 0; current !== undefined && depth < 16; depth++) {
    if (!isPlainObject(current.node)) {
      return [];
    }
    const alias = allOfAliasTarget(ctx, current);
    if (alias !== undefined) {
      if (isRefNode(alias.node)) {
        return [alias];
      }
      current = alias;
      continue;
    }
    if (!convertsToObject(ctx, current) || !Array.isArray(current.node.allOf)) {
      return [];
    }
    const result: Located[] = [];
    const allOf: AnyNode[] = current.node.allOf;
    allOf.forEach((member, index) => {
      if (!isRefNode(member)) {
        return;
      }
      const location = current!.location.child(['allOf', index]);
      const target = resolveNode(ctx, member, location);
      if (
        isPlainObject(target?.node) &&
        ((target.node.oneOf !== null && target.node.oneOf !== undefined) ||
          (target.node.anyOf !== null && target.node.anyOf !== undefined))
      ) {
        return;
      }
      result.push({ node: member, location });
    });
    return result;
  }
  return [];
}

export const noExtensionsWithFileUpload: RuleDefinition = {
  name: 'no-extensions-with-file-upload',
  vendor: 'fern',
  sourceRules: ['fern-definition/no-extensions-with-file-upload'],
  severity: 'error',
  description: 'Multipart (file upload) request body schemas cannot inherit properties through `allOf` `$ref`s.',
  rule: () => ({
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
            const schema = schemaOfMediaType(mediaType);
            if (schema === undefined) {
              continue;
            }
            for (const parent of droppedParents(ctx, schema)) {
              if (reported.has(parent.location.absolutePointer)) {
                continue;
              }
              reported.add(parent.location.absolutePointer);
              const name = refName(parent.node.$ref);
              ctx.report({
                message: `The \`${mediaType.mediaType}\` request body schema extends "${name}" through an \`allOf\` \`$ref\`. Request body extensions are not supported for file upload (multipart) requests, so Fern drops the properties inherited from "${name}". Declare them directly in the request body schema instead.`,
                location: parent.location.child('$ref').key(),
              });
            }
          }
        }
      },
    },
  }),
};
