/**
 * Reports tag names with non-ASCII characters (they end up in docs URL paths and HTTP headers)
 * and operation descriptions containing a `---` line (the docs renderer reads it as a YAML
 * frontmatter delimiter). Root `tags` names are checked; operation `tags` are checked only when
 * the document has no root `tags` array, and each name is reported once.
 */
import { getOperations, rootOf } from '../utils/document.ts';
import { isPlainObject } from '../utils/resolve.ts';
import type { AnyNode, RuleDefinition, UserContext } from '../utils/types.ts';

const FRONTMATTER = /(?:^|\n)\s*---\s*(?:\n|$)/;
const METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'trace']);

function isNonAsciiCharacter(character: string): boolean {
  return (character.codePointAt(0) ?? 0) > 0x7f;
}

function hasNonAscii(value: string): boolean {
  return [...value].some(isNonAsciiCharacter);
}

function tagMessage(tag: string): string {
  const nonAscii = [...tag].filter(isNonAsciiCharacter);
  return (
    `Tag name "${tag}" contains non-ASCII characters: ${nonAscii.join(', ')}. ` +
    'Non-ASCII characters in tag names will be included in URL paths and HTTP headers, ' +
    'which only support ASCII characters. This will cause runtime errors (ERR_INVALID_CHAR). ' +
    'Remove non-ASCII characters from the tag name.'
  );
}

export const noInvalidTagNamesOrFrontmatter: RuleDefinition = {
  name: 'no-invalid-tag-names-or-frontmatter',
  sourceRules: ['oss/no-invalid-tag-names-or-frontmatter'],
  severity: 'error',
  description: 'Tag names must be ASCII and operation descriptions must not contain `---` frontmatter delimiters.',
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        if (!isPlainObject(root)) {
          return;
        }
        const hasRootTags = Array.isArray(root.tags);
        if (hasRootTags) {
          root.tags.forEach((tag: AnyNode, index: number) => {
            if (isPlainObject(tag) && typeof tag.name === 'string' && hasNonAscii(tag.name)) {
              ctx.report({
                message: tagMessage(tag.name),
                location: ctx.location.child(['tags', index, 'name']),
              });
            }
          });
        }

        const seenOperationTags = new Set<string>();
        for (const operation of getOperations(ctx, rootOf(root, ctx))) {
          if (!METHODS.has(operation.method)) {
            continue;
          }
          const { node, location } = operation;
          if (typeof node.description === 'string' && FRONTMATTER.test(node.description)) {
            ctx.report({
              message:
                `Endpoint description for ${operation.method.toUpperCase()} ${operation.path} contains "---" which will be ` +
                'interpreted as a YAML frontmatter delimiter by the docs renderer, causing parsing ' +
                'failures and 500 errors on the generated docs site. Remove the "---" delimiters ' +
                'from the description.',
              location: location.child('description'),
            });
          }
          if (hasRootTags || !Array.isArray(node.tags)) {
            continue;
          }
          node.tags.forEach((tag: AnyNode, index: number) => {
            if (typeof tag === 'string' && !seenOperationTags.has(tag) && hasNonAscii(tag)) {
              seenOperationTags.add(tag);
              ctx.report({
                message: tagMessage(tag),
                location: location.child(['tags', index]),
              });
            }
          });
        }
      },
    },
  }),
};
