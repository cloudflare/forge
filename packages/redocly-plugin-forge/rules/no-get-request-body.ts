/**
 * Reports request bodies on GET and HEAD operations.
 *
 * Per RFC 9110 §9.3.1 and §9.3.2, these methods have no defined semantics for a request body.
 */
import { getOperations, rootOf } from '../utils/document.ts';
import type { AnyNode, RuleDefinition, UserContext } from '../utils/types.ts';

export const noGetRequestBody: RuleDefinition = {
  name: 'no-get-request-body',
  sourceRules: ['fern-definition/no-get-request-body'],
  severity: 'error',
  description: 'GET and HEAD operations cannot have a request body.',
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        for (const operation of getOperations(ctx, rootOf(root, ctx))) {
          if (operation.node.requestBody === undefined) {
            continue;
          }
          if (operation.method !== 'get' && operation.method !== 'head') {
            continue;
          }
          ctx.report({
            message: `${operation.method.toUpperCase()} operations cannot have a request body (RFC 9110 §9.3).`,
            location: operation.location.child('requestBody').key(),
          });
        }
      },
    },
  }),
};
