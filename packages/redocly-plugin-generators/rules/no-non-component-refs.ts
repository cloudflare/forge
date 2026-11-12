/**
 * Reports local `$ref`s (`#/...`) in the root document that do not point under `#/components/`,
 * such as references to paths or operations. The whole root document is walked, including `x-*`
 * extension values. Files reached through external `$ref`s are not checked: their local `$ref`s
 * point into those files, which have no `components` section of their own.
 *
 * Fern's docs check scans the raw file text for `$ref: "..."` (skipping YAML comments), so text
 * that only looks like a `$ref`, for example inside a description, fails it too; such text is
 * reported on the document.
 */
import { isPlainObject, isRefNode } from '../utils/resolve.ts';
import type { AnyNode, Location, RuleDefinition, UserContext } from '../utils/types.ts';

const REF_TEXT = /["']?\$ref["']?\s*:\s*["']([^"']+)["']/g;

function isNonComponentRef(ref: string): boolean {
  return ref.startsWith('#/') && !ref.startsWith('#/components/');
}

/** Whether the match at `index` sits in a YAML comment, as Fern's docs check decides it. */
function isInYamlComment(contents: string, index: number): boolean {
  const lineStart = contents.lastIndexOf('\n', index - 1) + 1;
  return contents
    .slice(lineStart, index)
    .replace(/"[^"]*"|'[^']*'/g, '')
    .includes('#');
}

export const noNonComponentRefs: RuleDefinition = {
  name: 'no-non-component-refs',
  vendor: 'fern',
  sourceRules: ['docs/no-non-component-refs'],
  severity: 'error',
  description: 'Local `$ref`s must point to reusable components under `#/components/`.',
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        const walked = new Set<AnyNode>();
        const reported = new Set<string>();
        // How many real `$ref`s use each non-component target.
        const refCounts = new Map<string, number>();

        const walk = (node: AnyNode, location: Location): void => {
          if (typeof node !== 'object' || node === null || walked.has(node)) {
            return;
          }
          walked.add(node);
          if (Array.isArray(node)) {
            node.forEach((item, index) => walk(item, location.child([index])));
            return;
          }
          if (isRefNode(node)) {
            const ref = node.$ref;
            if (isNonComponentRef(ref)) {
              refCounts.set(ref, (refCounts.get(ref) ?? 0) + 1);
              const refLocation = location.child('$ref');
              const key = `${refLocation.source.absoluteRef}${refLocation.pointer}`;
              if (!reported.has(key)) {
                reported.add(key);
                ctx.report({
                  message: `Reference "${ref}" points to a non-component location. OpenAPI references should point to reusable components under #/components/ (e.g., #/components/schemas/MySchema, #/components/responses/MyResponse). Direct references to paths, operations, or other spec sections are not supported.`,
                  location: refLocation,
                });
              }
            }
          }
          if (isPlainObject(node)) {
            for (const [key, value] of Object.entries(node)) {
              walk(value, location.child([key]));
            }
          }
        };

        walk(root, ctx.location);

        const contents = ctx.location.source.body;
        const textCounts = new Map<string, number>();
        for (const match of contents.matchAll(REF_TEXT)) {
          const ref = match[1];
          if (ref === undefined || !isNonComponentRef(ref) || isInYamlComment(contents, match.index)) {
            continue;
          }
          textCounts.set(ref, (textCounts.get(ref) ?? 0) + 1);
        }
        for (const [ref, count] of textCounts) {
          if (count > (refCounts.get(ref) ?? 0)) {
            ctx.report({
              message: `The text $ref: "${ref}" appears outside a real $ref (for example inside a description). Fern's docs check scans the raw file and rejects it as a reference to a non-component location; reword the text so it does not look like a $ref.`,
              location: ctx.location,
            });
          }
        }
      },
    },
  }),
};
