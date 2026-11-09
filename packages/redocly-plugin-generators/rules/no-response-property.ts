/**
 * Validates `x-fern-sdk-return-value` on operations: the SDK returns that top-level property of
 * the JSON success response instead of the whole response, so the response must be an object that
 * declares the property. On streaming endpoints (`x-fern-streaming` without `stream-condition`) and
 * endpoints without a JSON success response Fern drops the extension.
 */
import { endpointId, getOperations, rootOf, type OperationInfo } from '../utils/document.ts';
import { describeMissingResponse, getFernResponse, isIgnored, streamingMode } from '../utils/property-path.ts';
import { isPlainObject } from '../utils/resolve.ts';
import { collectProperties, isObjectSchema, unwrapSchema } from '../utils/schema.ts';
import type { AnyNode, Located, RuleDefinition, UserContext } from '../utils/types.ts';

const EXTENSION = 'x-fern-sdk-return-value';

type Target =
  | { kind: 'schema'; schema: Located | undefined }
  | { kind: 'untyped' }
  | { kind: 'ignored'; reason: string };

/** The schema whose property the SDK returns, following Fern's importer. */
function targetSchema(ctx: UserContext, operation: OperationInfo): Target {
  const mode = streamingMode(operation.node);
  const streaming = operation.node['x-fern-streaming'];
  if (mode === 'stream-condition') {
    return isPlainObject(streaming) && streaming.response != null
      ? {
          kind: 'schema',
          schema: {
            node: streaming.response,
            location: operation.location.child(['x-fern-streaming', 'response']),
          },
        }
      : { kind: 'untyped' };
  }
  if (mode === 'stream') {
    const format =
      isPlainObject(streaming) && streaming.format === 'sse'
        ? 'server-sent events (x-fern-streaming format: sse)'
        : 'JSON (x-fern-streaming)';
    return {
      kind: 'ignored',
      reason: `it streams ${format}, and Fern only applies it to non-streaming JSON responses`,
    };
  }
  const response = getFernResponse(ctx, operation);
  return response.kind === 'json'
    ? { kind: 'schema', schema: response.schema }
    : {
        kind: 'ignored',
        reason: `${describeMissingResponse(response.reason)}, and Fern only applies it to JSON responses`,
      };
}

/** Whether Fern imports the schema as a map rather than an object with properties. */
function isMap(ctx: UserContext, schema: Located | undefined): boolean {
  const resolved = unwrapSchema(ctx, schema);
  if (resolved === undefined || !isPlainObject(resolved.node)) {
    return false;
  }
  const additional = resolved.node.additionalProperties;
  return (additional === true || isPlainObject(additional)) && collectProperties(ctx, resolved).length === 0;
}

export const noResponseProperty: RuleDefinition = {
  name: 'no-response-property',
  sourceRules: ['fern-definition/no-response-property'],
  severity: 'error',
  description: 'x-fern-sdk-return-value must name a top-level property of the JSON success response.',
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        for (const operation of getOperations(ctx, rootOf(root, ctx))) {
          if (isIgnored(operation.node)) {
            continue;
          }
          const value = operation.node[EXTENSION];
          if (value === undefined) {
            continue;
          }
          const location = operation.location.child(EXTENSION);
          if (typeof value !== 'string') {
            ctx.report({
              message: `${EXTENSION} must be a string naming a top-level property of the response.`,
              location,
            });
            continue;
          }
          const target = targetSchema(ctx, operation);
          if (target.kind === 'ignored') {
            ctx.report({
              message: `${EXTENSION} has no effect on endpoint ${endpointId(operation)}: ${target.reason}.`,
              location,
            });
            continue;
          }
          if (target.kind === 'untyped') {
            ctx.report({
              message: `Response must be an object in order to return a property as a response: endpoint ${endpointId(operation)} has an x-fern-streaming stream-condition without a response schema, so Fern imports its non-streaming response as an untyped value and ${EXTENSION} cannot select a property from it.`,
              location,
            });
            continue;
          }
          if (!isObjectSchema(ctx, target.schema) || isMap(ctx, target.schema)) {
            ctx.report({
              message: `Response must be an object in order to return a property as a response: the response of endpoint ${endpointId(operation)} is not an object schema with properties, so ${EXTENSION} cannot select a property from it.`,
              location,
            });
            continue;
          }
          const exists = collectProperties(ctx, target.schema).some((property) => property.key === value);
          if (!exists) {
            ctx.report({
              message: `Response does not have a property named ${value}. ${EXTENSION} must name a top-level property of the response of endpoint ${endpointId(operation)}.`,
              location,
            });
          }
        }
      },
    },
  }),
};
