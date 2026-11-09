/**
 * Validates SDK variables: `x-fern-sdk-variables` (document root) declares string variables, and
 * each parameter's `x-fern-sdk-variable` names one of them. Fern only reads the reference on
 * path parameters and adds the `$` prefix itself.
 */
import { getOperations, rootOf } from '../utils/document.ts';
import { describeValue, isNonEmptyString, readExtension } from '../utils/extensions.ts';
import { rootValue } from '../utils/extensions-servers.ts';
import { isPlainObject, resolveChild } from '../utils/resolve.ts';
import type { AnyNode, RuleDefinition, UserContext } from '../utils/types.ts';

export const noUndefinedVariableReference: RuleDefinition = {
  name: 'no-undefined-variable-reference',
  vendor: 'fern',
  sourceRules: ['fern-definition/no-undefined-variable-reference'],
  severity: 'error',
  description:
    'x-fern-sdk-variable references a string variable declared in x-fern-sdk-variables, on a path parameter.',
  rule: () => ({
    Root: {
      leave(rootNode: AnyNode, ctx: UserContext) {
        const root = rootOf(rootNode, ctx);
        const declared = new Set<string>();
        const variables = rootValue(ctx, root, 'x-fern-sdk-variables');
        if (variables !== undefined && !isPlainObject(variables.node)) {
          ctx.report({
            message:
              'x-fern-sdk-variables must be an object mapping variable names to schemas with type: string. Fern fails to import the document.',
            location: variables.location,
          });
          return;
        }
        if (variables !== undefined) {
          for (const name of Object.keys(variables.node)) {
            declared.add(name);
            const schema = resolveChild(ctx, variables, name);
            if (schema === undefined || !isPlainObject(schema.node) || schema.node.type !== 'string') {
              ctx.report({
                message: `Variable ${name} has an unsupported schema: x-fern-sdk-variables entries must be schemas with type: string. Fern fails to import the document.`,
                location:
                  isPlainObject(schema?.node) && schema!.node.type !== undefined
                    ? schema!.location.child(['type'])
                    : (schema?.location ?? variables.location.child([name])),
              });
              continue;
            }
            const env = schema.node['x-fern-env'];
            if (env !== undefined && env !== null && !(isNonEmptyString(env) && env.trim().length > 0)) {
              ctx.report({
                message: `Variable ${name} has invalid x-fern-env: expected a non-empty string but got ${JSON.stringify(env)}. Fern fails to import the document.`,
                location: schema.location.child(['x-fern-env']),
              });
            }
          }
        }

        const seen = new Set<string>();
        for (const operation of getOperations(ctx, root, {
          includeWebhooks: true,
        })) {
          for (const parameter of operation.allParameters) {
            const pointer = parameter.location.absolutePointer;
            if (seen.has(pointer)) {
              continue;
            }
            seen.add(pointer);
            const reference = readExtension(
              ctx,
              { node: parameter.node, location: parameter.location },
              'x-fern-sdk-variable',
            );
            if (reference === undefined || reference.node === null) {
              continue;
            }
            if (parameter.in !== 'path') {
              ctx.report({
                message: `x-fern-sdk-variable is ignored on the in: ${parameter.in} parameter '${parameter.name}'; Fern only supports SDK variables on path parameters.`,
                location: reference.location,
                forceSeverity: 'warn',
              });
              continue;
            }
            if (typeof reference.node !== 'string') {
              // Fern interpolates the value into `$<value>`, so ['appId'] still names appId.
              const coerced = `${reference.node}`;
              if (!declared.has(coerced)) {
                ctx.report({
                  message: `x-fern-sdk-variable must be the name of a variable declared in x-fern-sdk-variables; got ${describeValue(reference.node)}, which Fern reads as the undefined variable $${coerced}.`,
                  location: reference.location,
                });
              }
              continue;
            }
            const name = reference.node;
            if (name.startsWith('$')) {
              ctx.report({
                message: `x-fern-sdk-variable must name the variable without a leading $ (Fern adds it, producing $${name}); use '${name.slice(1)}'.`,
                location: reference.location,
              });
              continue;
            }
            if (!declared.has(name)) {
              ctx.report({
                message: `Variable ${name} is not defined. Declare it in x-fern-sdk-variables at the root of the document.`,
                location: reference.location,
              });
            }
          }
        }
      },
    },
  }),
};
