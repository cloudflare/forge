/**
 * Reports `in: path` parameters whose SDK name is `request`, which generated SDKs use for the
 * request body argument. The SDK name is `x-fern-parameter-name` when set, otherwise `name`;
 * a path parameter that the importer automatically renames (because another request property
 * already uses its name) is not reported.
 */
import { rootOf } from '../utils/document.ts';
import type { RefOccurrence } from '../utils/naming-request-wrapper.ts';
import { buildRequestWrapper, documentFacts } from '../utils/naming-request-wrapper.ts';
import type { AnyNode, RuleDefinition, UserContext } from '../utils/types.ts';

const REQUEST_PARAMETER_NAME = 'request';

export const noConflictingEndpointParameters: RuleDefinition = {
  name: 'no-conflicting-endpoint-parameters',
  vendor: 'fern',
  sourceRules: ['fern-definition/no-conflicting-endpoint-parameters'],
  severity: 'error',
  description: 'Path parameters must not be named "request", which conflicts with the request body argument.',
  rule: () => {
    const refs: RefOccurrence[] = [];
    return {
      ref: {
        enter(_node: AnyNode, ctx: UserContext, resolved: AnyNode) {
          if (resolved?.location !== undefined) {
            refs.push({
              from: ctx.location.absolutePointer,
              to: resolved.location.absolutePointer,
            });
          }
        },
      },
      Root: {
        leave(root: AnyNode, ctx: UserContext) {
          const facts = documentFacts(ctx, rootOf(root, ctx), refs);
          const reported = new Set<string>();
          for (const operation of facts.operations) {
            const { pathParameterNames } = buildRequestWrapper(ctx, operation, facts);
            for (const { parameter, name } of pathParameterNames) {
              if (name !== REQUEST_PARAMETER_NAME) {
                continue;
              }
              const overridden = parameter.name !== name;
              const location = parameter.location.child(overridden ? 'x-fern-parameter-name' : 'name');
              if (reported.has(location.absolutePointer)) {
                continue;
              }
              reported.add(location.absolutePointer);
              const subject = overridden
                ? `Path parameter "${parameter.name}" (x-fern-parameter-name: "${name}")`
                : `Path parameter "${name}"`;
              ctx.report({
                message: `${subject} is not suitable for code generation, because it can conflict with the request body parameter. Use x-fern-parameter-name to rename it.`,
                location,
              });
            }
          }
        },
      },
    };
  },
};
