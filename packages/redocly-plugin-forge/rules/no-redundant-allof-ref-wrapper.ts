/**
 * Flags `allOf: [{$ref: '...'}]` wrappers that exist only to attach annotation siblings
 * (`description`, `example`, `title`, …) to a `$ref`. In OAS 3.0 this wrapper is the only
 * workaround — `$ref` siblings are ignored — but OAS 3.1 adopts JSON Schema 2020-12 semantics
 * where `$ref` composes with siblings directly, making the wrapper redundant.
 *
 * Reports only on OAS 3.1 and 3.2. Deliberately scoped to the "only annotation siblings"
 * shape; a wrapper that composes schema-shaping siblings (`properties`, `items`, `type`, `required`,
 * `enum`, …) with a `$ref` is left alone, since that is a recognizable inheritance idiom many
 * authors prefer to keep spelled out even where `$ref` siblings would also work.
 */
import { isPlainObject, isRefNode } from '../utils/resolve.ts';
import { refName } from '../utils/schema.ts';
import type { AnyNode, RuleDefinition, UserContext } from '../utils/types.ts';

// Keywords that only describe or annotate the schema — they add no validation constraint.
// If every non-`allOf` sibling on the enclosing schema is in this set, the `allOf` wrapper is
// doing no composition work and can be unwrapped to `{$ref, ...annotations}` on OAS 3.1+.
const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  'description',
  'title',
  'example',
  'examples',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
  'externalDocs',
  'xml',
  '$comment',
]);

function isAnnotationOnly(schema: Record<string, AnyNode>): boolean {
  let sawAnnotation = false;
  for (const key of Object.keys(schema)) {
    if (key === 'allOf') {
      continue;
    }
    if (key.startsWith('x-')) {
      continue;
    }
    if (!ANNOTATION_KEYWORDS.has(key)) {
      return false;
    }
    sawAnnotation = true;
  }
  return sawAnnotation;
}

export const noRedundantAllofRefWrapper: RuleDefinition = {
  name: 'no-redundant-allof-ref-wrapper',
  sourceRules: [],
  severity: 'warn',
  recommended: false,
  description:
    'Single-member `allOf: [{$ref}]` wrappers that only attach annotations are redundant on OAS 3.1+; attach the annotations directly to the `$ref`.',
  rule: () => ({
    Schema(schema: AnyNode, ctx: UserContext) {
      if (ctx.specVersion !== 'oas3_1' && ctx.specVersion !== 'oas3_2') {
        return;
      }
      if (!isPlainObject(schema) || !Array.isArray(schema.allOf) || schema.allOf.length !== 1) {
        return;
      }
      const [member] = schema.allOf;
      if (!isRefNode(member)) {
        return;
      }
      if (!isAnnotationOnly(schema)) {
        return;
      }
      ctx.report({
        message:
          `\`allOf\` with the single member $ref "${refName(member.$ref)}" only serves to attach annotation siblings.` +
          ' On OpenAPI 3.1+, `$ref` composes with sibling keywords directly — drop the `allOf` wrapper and attach the siblings to the `$ref`.',
        location: ctx.location.child('allOf').key(),
      });
    },
  }),
};
