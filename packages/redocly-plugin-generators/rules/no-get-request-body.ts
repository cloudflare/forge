/**
 * Reports request bodies on GET and HEAD operations.
 *
 * - GET: Fern's importer drops the request body, so the generated SDK never sends it.
 * - HEAD: Fern keeps the request body (JSON, multipart, form-urlencoded or binary content) and
 *   its validator then rejects the endpoint. Bodies with only other media types are dropped
 *   before validation and are not reported.
 *
 * Operations Fern does not import (`x-fern-ignore: true`, webhooks) are skipped.
 */
import { getOperations, rootOf } from '../utils/document.ts';
import { fernRequestMediaTypes, isFernEndpoint } from '../utils/structure.ts';
import type { AnyNode, RuleDefinition, UserContext } from '../utils/types.ts';

export const noGetRequestBody: RuleDefinition = {
  name: 'no-get-request-body',
  vendor: 'fern',
  sourceRules: ['fern-definition/no-get-request-body'],
  severity: 'error',
  description: 'GET and HEAD operations cannot have a request body.',
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        for (const operation of getOperations(ctx, rootOf(root, ctx))) {
          if (!isFernEndpoint(operation) || operation.node.requestBody === undefined) {
            continue;
          }
          const location = operation.location.child('requestBody').key();
          if (operation.method === 'get') {
            ctx.report({
              message:
                'Operation is a GET, so it cannot have a request body. Fern ignores the `requestBody` of GET operations, so the generated SDKs never send it.',
              location,
            });
          } else if (operation.method === 'head' && fernRequestMediaTypes(ctx, operation).length > 0) {
            ctx.report({
              message: 'Operation is a HEAD, so it cannot have a request body.',
              location,
            });
          }
        }
      },
    },
  }),
};
