/**
 * Reports multipart request body schemas that inherit properties through an `allOf` `$ref`.
 *
 * Forge's multipart code generation inlines a body's properties directly; properties inherited
 * from a referenced parent via `allOf` are dropped. `$ref`s to `oneOf`/`anyOf` unions are not
 * reported — Forge inlines union members. Operations with `x-forge-skip: true` are ignored.
 *
 * The source Fern rule (`fern-definition/no-extensions-with-file-upload`) is adapted to Forge.
 */
import { getOperations, rootOf, schemaOfMediaType } from '../utils/document.ts';
import { isPlainObject, isRefNode, resolveChild, resolveNode } from '../utils/resolve.ts';
import { refName } from '../utils/schema.ts';
import { isMultipartMediaType } from '../utils/structure.ts';
import type { AnyNode, Located, RuleDefinition, UserContext } from '../utils/types.ts';

function isUnion(node: AnyNode): boolean {
  if (!isPlainObject(node)) {
    return false;
  }
  return Array.isArray(node.oneOf) || Array.isArray(node.anyOf);
}

function visit(ctx: UserContext, mediaType: string, schema: Located, reported: Set<string>): void {
  const resolved = resolveNode(ctx, schema.node, schema.location);
  if (resolved === undefined || !isPlainObject(resolved.node)) {
    return;
  }
  const allOf = resolved.node.allOf;
  if (!Array.isArray(allOf)) {
    return;
  }
  allOf.forEach((member: AnyNode, index: number) => {
    const memberLocation = resolved.location.child(['allOf', index]);
    if (isRefNode(member)) {
      const target = resolveNode(ctx, member, memberLocation);
      if (target === undefined || isUnion(target.node)) {
        return;
      }
      const key = target.location.absolutePointer;
      if (reported.has(key)) {
        return;
      }
      reported.add(key);
      ctx.report({
        message:
          `The \`${mediaType}\` request body schema inherits properties from "${refName(member.$ref)}" through an \`allOf\` \`$ref\`. ` +
          `Forge drops inherited properties on multipart requests; declare them directly in the request body schema.`,
        location: memberLocation.child('$ref').key(),
      });
      return;
    }
    if (isPlainObject(member)) {
      visit(ctx, mediaType, { node: member, location: memberLocation }, reported);
    }
  });
}

export const noMultipartAllofComposition: RuleDefinition = {
  name: 'no-multipart-allof-composition',
  vendor: 'forge',
  sourceRules: ['fern-definition/no-extensions-with-file-upload'],
  severity: 'error',
  description: 'Multipart request body schemas must not inherit properties through `allOf` `$ref`.',
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        for (const operation of getOperations(ctx, rootOf(root, ctx))) {
          if (!isPlainObject(operation.node) || operation.node['x-forge-skip'] === true) {
            continue;
          }
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
            const schema = schemaOfMediaType(mediaType);
            if (schema === undefined) {
              continue;
            }
            visit(ctx, mediaTypeKey, schema, new Set());
          }
        }
      },
    },
  }),
};
