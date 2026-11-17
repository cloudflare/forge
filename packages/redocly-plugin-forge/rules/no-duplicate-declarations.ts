/**
 * Reports names Fern would declare more than once in the same directory of the generated Fern
 * definition: type names (from `components.schemas` keys, `x-fern-type-name` on component and
 * inline schemas), request wrapper names (`x-fern-request-name` / `x-request-name`, the request
 * body schema's `x-fern-type-name`, or the name generated from the SDK method name or operationId)
 * and error names (one per 4xx/5xx status code).
 *
 * Most collisions make `fern check` fail. Two types with the same name in the same Fern definition
 * file do not: Fern keeps only one of them and silently drops the other, so references to the
 * dropped schema end up pointing at a different one. Both are reported as errors.
 *
 * Fern inlines a component used as a JSON request body into the request (and names the request
 * after it) only when no other operation or schema references the component. Operations with an
 * `x-fern-streaming` stream-condition become two endpoints whose requests are named separately.
 *
 * Collisions Fern resolves on its own are not reported: component keys equal to an error name are
 * renamed with a `Body` suffix, and generated request names that clash with a component schema get
 * a `Body` suffix. Duplicate operationIds are covered by Redocly's `operation-operationId-unique`.
 *
 * Options:
 * - `resolveSchemaCollisions` (boolean, default false): mirrors the `resolve-schema-collisions`
 *   setting in generators.yml, which makes Fern number repeated `x-fern-type-name` values.
 */
import { rootOf } from '../utils/document.ts';
import {
  collectDeclarations,
  describeLocation,
  isInlineTypeDeclaration,
  type Declaration,
} from '../utils/type-names-declarations.ts';
import type { AnyNode, Located, RuleDefinition, UserContext } from '../utils/types.ts';

interface Options {
  resolveSchemaCollisions?: boolean;
}

function renameHint(declaration: Declaration, other: Declaration): string {
  const target = declaration.kind === 'error' ? other : declaration;
  if (target.source === 'stream-condition') {
    return target === declaration
      ? 'Name the two requests with x-fern-request-name on the operation and stream-request-name in x-fern-streaming.'
      : `Name the requests of ${target.subject.replace(/^the (non-)?streaming request of /, '')} with x-fern-request-name on the operation and stream-request-name in x-fern-streaming.`;
  }
  switch (target.kind) {
    case 'request':
      return target === declaration
        ? 'Rename this request with x-fern-request-name on the operation.'
        : `Rename ${target.subject} with x-fern-request-name on the operation.`;
    case 'type':
      return target === declaration
        ? 'Rename one of them with x-fern-type-name.'
        : `Rename ${target.subject} with x-fern-type-name.`;
    default:
      return 'Rename one of them.';
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function isAutoResolved(declaration: Declaration, first: Declaration, options: Options): boolean {
  if (
    options.resolveSchemaCollisions === true &&
    declaration.source === 'x-fern-type-name' &&
    first.source === 'x-fern-type-name'
  ) {
    return true;
  }
  return (
    declaration.node !== undefined &&
    first.node !== undefined &&
    JSON.stringify(declaration.node) === JSON.stringify(first.node)
  );
}

export const noDuplicateDeclarations: RuleDefinition = {
  name: 'no-duplicate-declarations',
  sourceRules: ['fern-definition/no-duplicate-declarations'],
  severity: 'error',
  description: 'Type, request wrapper and error names Fern generates must be unique.',
  rule: (options: Options = {}) => {
    const inlineTypes: Located[] = [];
    let rootRef = '';
    return {
      Root: {
        enter(_root: AnyNode, ctx: UserContext) {
          rootRef = ctx.location.source.absoluteRef;
        },
        leave(root: AnyNode, ctx: UserContext) {
          const { declarations } = collectDeclarations(ctx, rootOf(root, ctx), inlineTypes);
          const groups = new Map<string, Declaration[]>();
          for (const declaration of declarations) {
            const key = `${declaration.scope}\u0000${declaration.name}`;
            const group = groups.get(key) ?? [];
            group.push(declaration);
            groups.set(key, group);
          }
          for (const group of groups.values()) {
            const [first, ...rest] = group;
            if (first === undefined) {
              continue;
            }
            for (const declaration of rest) {
              if (isAutoResolved(declaration, first, options)) {
                continue;
              }
              const overwritten =
                declaration.kind === 'type' &&
                first.kind === 'type' &&
                declaration.file !== undefined &&
                declaration.file === first.file;
              const consequence = overwritten
                ? `Both become Fern types named "${declaration.name}" in the same file, so Fern keeps only one of them and silently drops the other; references to the dropped schema point to the one Fern keeps.`
                : `fern check fails with "${declaration.name} is already declared".`;
              const streamNote =
                declaration.source === 'stream-condition' || first.source === 'stream-condition'
                  ? ' Fern splits an operation with an x-fern-streaming stream-condition into a streaming and a non-streaming endpoint, each with its own request.'
                  : '';
              ctx.report({
                message: `${capitalize(declaration.description)} is named "${declaration.name}", which is already declared by ${first.description} at ${describeLocation(first.location, rootRef)}. ${consequence}${streamNote} ${renameHint(declaration, first)}`,
                location: declaration.location,
              });
            }
          }
        },
      },
      Schema(schema: AnyNode, ctx: UserContext) {
        const located = { node: schema, location: ctx.location };
        if (isInlineTypeDeclaration(ctx, located, rootRef)) {
          inlineTypes.push(located);
        }
      },
    };
  },
};
