/**
 * Validates `x-fern-streaming` on operations.
 *
 * The extension is `true` or an object. An object streams the response when it has `format`
 * (`sse` or `json`); with `stream-condition` it splits the operation into a streaming and a
 * non-streaming endpoint, selected by a boolean property of the JSON request body, and then needs
 * both `response` and `response-stream` schemas.
 */
import {
  endpointId,
  getJsonMediaType,
  getOperations,
  getRequestBody,
  rootOf,
  schemaOfMediaType,
  type OperationInfo,
} from '../utils/document.ts';
import { isIgnored, REQUEST_PREFIX } from '../utils/property-path.ts';
import { isPlainObject, resolveNode } from '../utils/resolve.ts';
import { collectProperties, fernPrimitive, unwrapSchema } from '../utils/schema.ts';
import type { AnyNode, Location, RuleDefinition, UserContext } from '../utils/types.ts';

const EXTENSION = 'x-fern-streaming';

const STRING_FIELDS = ['stream-description', 'stream-request-name', 'terminator'];

/** The property name Fern's importer reads from `stream-condition`, or undefined if malformed. */
function conditionProperty(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const property = value.startsWith(REQUEST_PREFIX) ? value.slice(REQUEST_PREFIX.length) : value;
  if (property.length === 0 || property.includes('.') || property.startsWith('$')) {
    return undefined;
  }
  return property;
}

function checkCondition(ctx: UserContext, operation: OperationInfo, value: AnyNode, location: Location): void {
  const property = conditionProperty(value);
  if (property === undefined) {
    ctx.report({
      message:
        'Please specify path to a valid property (e.g. $request.stream). stream-condition must name a top-level property of the JSON request body, optionally prefixed with $request.',
      location,
    });
    return;
  }
  const requestBody = getRequestBody(ctx, operation);
  const media = getJsonMediaType(ctx, requestBody);
  if (media === undefined) {
    ctx.report({
      message: `stream-condition ${value} requires a JSON request body, but endpoint ${endpointId(operation)} has none, so Fern generates its streaming and non-streaming endpoints without a request body to select between them.`,
      location,
    });
    return;
  }
  const bodySchema = schemaOfMediaType(media);
  const resolved = bodySchema === undefined ? undefined : resolveNode(ctx, bodySchema.node, bodySchema.location);
  const schema = resolved?.node;
  if (
    !isPlainObject(schema) ||
    ((schema.allOf === null || schema.allOf === undefined) &&
      (schema.properties === null || schema.properties === undefined) &&
      (schema.oneOf === null || schema.oneOf === undefined) &&
      (schema.anyOf === null || schema.anyOf === undefined))
  ) {
    ctx.report({
      message: `stream-condition ${value} requires the JSON request body to be an object schema with properties; Fern drops a request body that is not, so endpoint ${endpointId(operation)} would lose its request body.`,
      location,
    });
    return;
  }
  const found = collectProperties(ctx, resolved).find((candidate) => candidate.key === property);
  if (found === undefined) {
    ctx.report({
      message: `Property "${value}" does not exist on the request. Fern adds a required boolean "${property}" property to the request body; declare it in the schema so the documented request matches.`,
      location,
      forceSeverity: 'warn',
    });
    return;
  }
  const unwrapped = unwrapSchema(ctx, found.schema);
  if (unwrapped === undefined || fernPrimitive(ctx, unwrapped) !== 'BOOLEAN') {
    ctx.report({
      message: `Property "${value}" must be a boolean to be used as a stream-condition. Fern replaces it with a boolean in the generated request types.`,
      location: found.schema.location,
      forceSeverity: 'warn',
    });
  }
}

function checkObject(
  ctx: UserContext,
  operation: OperationInfo,
  streaming: Record<string, AnyNode>,
  location: Location,
): void {
  const hasCondition = streaming['stream-condition'] !== null && streaming['stream-condition'] !== undefined;
  const hasResponse = streaming.response !== null && streaming.response !== undefined;
  const hasResponseStream = streaming['response-stream'] !== null && streaming['response-stream'] !== undefined;

  if (
    streaming.format !== null &&
    streaming.format !== undefined &&
    streaming.format !== 'sse' &&
    streaming.format !== 'json'
  ) {
    ctx.report({
      message: hasCondition
        ? `${EXTENSION} format must be 'sse' or 'json'.`
        : `${EXTENSION} format must be 'sse' or 'json'. Fern ignores x-fern-streaming with another format, so endpoint ${endpointId(operation)} does not stream.`,
      location: location.child('format'),
    });
  }
  for (const field of STRING_FIELDS) {
    if (streaming[field] !== null && streaming[field] !== undefined && typeof streaming[field] !== 'string') {
      ctx.report({
        message: `${EXTENSION} ${field} must be a string.`,
        location: location.child(field),
        forceSeverity: 'warn',
      });
    }
  }
  if (streaming.resumable !== null && streaming.resumable !== undefined && typeof streaming.resumable !== 'boolean') {
    ctx.report({
      message: `${EXTENSION} resumable must be a boolean. Fern treats any other value as false.`,
      location: location.child('resumable'),
    });
  } else if (streaming.resumable === true && streaming.format !== 'sse') {
    ctx.report({
      message: `${EXTENSION} resumable only applies to server-sent events; set format: sse or remove resumable.`,
      location: location.child('resumable'),
      forceSeverity: 'warn',
    });
  }

  if (!hasCondition && (streaming.format === null || streaming.format === undefined)) {
    ctx.report({
      message: `${EXTENSION} has neither format nor stream-condition, so Fern ignores it and endpoint ${endpointId(operation)} does not stream. Set format: sse or format: json, or use true.`,
      location,
    });
    return;
  }

  if (hasCondition) {
    if (!hasResponse || !hasResponseStream) {
      const untyped =
        !hasResponse && !hasResponseStream
          ? 'non-streaming and streamed responses'
          : hasResponse
            ? 'streamed response'
            : 'non-streaming response';
      ctx.report({
        message: `stream-condition can only be used if both response and response-stream are specified. Fern types the ${untyped} of endpoint ${endpointId(operation)} as unknown.`,
        location: location.child('stream-condition'),
      });
    }
    checkCondition(ctx, operation, streaming['stream-condition'], location.child('stream-condition'));
    return;
  }

  if (hasResponse && hasResponseStream) {
    ctx.report({
      message: `stream-condition must be specified when both response and response-stream are specified. Without it, Fern ignores both schemas and endpoint ${endpointId(operation)} only streams its OpenAPI success response.`,
      location,
    });
    return;
  }
  for (const field of ['response', 'response-stream']) {
    if (streaming[field] !== null && streaming[field] !== undefined) {
      ctx.report({
        message: `${EXTENSION} ${field} only applies together with stream-condition; Fern ignores it.`,
        location: location.child(field),
        forceSeverity: 'warn',
      });
    }
  }
}

export const validStreamCondition: RuleDefinition = {
  name: 'valid-stream-condition',
  vendor: 'fern',
  sourceRules: ['fern-definition/valid-stream-condition'],
  severity: 'error',
  description:
    'x-fern-streaming must be well-formed and its stream-condition must name a boolean request body property.',
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        for (const operation of getOperations(ctx, rootOf(root, ctx))) {
          if (isIgnored(operation.node)) {
            continue;
          }
          const streaming = operation.node[EXTENSION];
          if (streaming === null || streaming === undefined || typeof streaming === 'boolean') {
            continue;
          }
          const location = operation.location.child(EXTENSION);
          if (!isPlainObject(streaming)) {
            ctx.report({
              message: `${EXTENSION} must be true or an object. Fern ignores any other value, so endpoint ${endpointId(operation)} does not stream.`,
              location,
            });
            continue;
          }
          checkObject(ctx, operation, streaming, location);
        }
      },
    },
  }),
};
