/**
 * Checks that the names of the types Fern declares begin with a letter: `x-fern-type-name` values
 * on component and inline schemas, and the names Fern generates from `components.schemas` keys.
 * Fern spells out leading numbers (`2fa` becomes `TwoFa`, and numbers above 9999 become
 * `undefined_`), so generated names only fail for keys made only of symbols, keys that are only a
 * number above 9999 and keys starting with a non-ASCII letter.
 *
 * Request names (`x-fern-request-name`, `x-request-name`, the `x-fern-type-name` of an inline
 * request body and component schemas Fern inlines into a request) are not type declarations, and
 * Fern does not check them.
 *
 * Redocly's `spec-components-invalid-map-name` only restricts keys to `^[a-zA-Z0-9.\-_]+$`.
 */
import { rootOf } from '../utils/document.ts';
import { TYPE_NAME_REGEX } from '../utils/type-names.ts';
import { collectDeclarations, isInlineTypeDeclaration, type Declaration } from '../utils/type-names-declarations.ts';
import type { AnyNode, Located, RuleDefinition, UserContext } from '../utils/types.ts';

function message(declaration: Declaration): string | undefined {
  const name = `"${declaration.name}"`;
  switch (declaration.source) {
    case 'schema-key':
      return `Type name must begin with a letter: Fern generates the type name ${name} from the components.schemas key "${declaration.schemaKey}". Add x-fern-type-name with a name that begins with a letter.`;
    case 'x-fern-type-name':
      return `Type name must begin with a letter, but x-fern-type-name is ${name}.`;
    default:
      return undefined;
  }
}

export const validTypeName: RuleDefinition = {
  name: 'valid-type-name',
  vendor: 'fern',
  sourceRules: ['fern-definition/valid-type-name'],
  severity: 'error',
  description: 'Type names Fern declares must begin with a letter.',
  rule: () => {
    const inlineTypes: Located[] = [];
    let rootRef = '';
    return {
      Root: {
        enter(_root: AnyNode, ctx: UserContext) {
          rootRef = ctx.location.source.absoluteRef;
        },
        leave(root: AnyNode, ctx: UserContext) {
          const { declarations } = collectDeclarations(ctx, rootOf(root, ctx), inlineTypes);
          for (const declaration of declarations) {
            if (declaration.kind !== 'type' || TYPE_NAME_REGEX.test(declaration.name)) {
              continue;
            }
            const text = message(declaration);
            if (text !== undefined) {
              ctx.report({ message: text, location: declaration.location });
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
