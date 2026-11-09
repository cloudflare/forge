/**
 * `$request.<path>` / `$response.<path>` property selectors, resolved against an OpenAPI operation
 * the way Fern's validator resolves them against the Fern definition generated from it.
 *
 * Request side: a single-segment path matches an `in: query` parameter by its wire name first and
 * then a request body property; a multi-segment path only matches the body. Body lookups walk
 * object schemas (allOf merged, nullable/optional wrappers unwrapped) but never descend into
 * oneOf/anyOf unions, arrays or maps. Path parameters and headers never match.
 *
 * Response side: the path is looked up in the schema of the success response (the first of 200,
 * 201, 202 and 204, otherwise `default`) with JSON content.
 */
import {
  getJsonMediaType,
  getMediaType,
  getRequestBody,
  getSuccessResponse,
  schemaOfMediaType,
  type OperationInfo,
} from './document.ts';
import { isPlainObject, resolveNode } from './resolve.ts';
import {
  collectProperties,
  fernPrimitive,
  isObjectSchema,
  nonNullType,
  unwrapSchema,
  type FernPrimitive,
} from './schema.ts';
import type { AnyNode, Located, UserContext } from './types.ts';

type Ctx = Pick<UserContext, 'resolve'>;

export const REQUEST_PREFIX = '$request.';
export const RESPONSE_PREFIX = '$response.';

/** Strips `prefix` and splits the rest on `.`, as Fern does. Undefined when the prefix is missing. */
export function parseSelector(value: unknown, prefix: string): string[] | undefined {
  if (typeof value !== 'string' || !value.startsWith(prefix)) {
    return undefined;
  }
  return value.slice(prefix.length).split('.');
}

/** Decides whether the schema a selector points at has an acceptable type. */
export type SchemaPredicate = (ctx: Ctx, schema: Located) => boolean;

/** Accepts schemas that import as one of the given Fern primitives. */
export function primitiveIn(...primitives: FernPrimitive[]): SchemaPredicate {
  return (ctx, schema) => {
    const primitive = fernPrimitive(ctx, schema);
    return primitive !== undefined && primitives.includes(primitive);
  };
}

/** Accepts any primitive other than the excluded ones. */
export function primitiveExcept(...excluded: FernPrimitive[]): SchemaPredicate {
  return (ctx, schema) => {
    const primitive = fernPrimitive(ctx, schema);
    return primitive !== undefined && !excluded.includes(primitive);
  };
}

/** Accepts anything: only checks that the property exists. */
export const anySchema: SchemaPredicate = () => true;

/** Accepts array schemas (after unwrapping nullable wrappers). */
export const arraySchema: SchemaPredicate = (ctx, schema) => {
  const resolved = unwrapSchema(ctx, schema);
  return resolved !== undefined && isPlainObject(resolved.node) && nonNullType(resolved.node) === 'array';
};

/** Result of resolving a property path. */
export interface PropertyLookup {
  /** Whether a property was found and satisfied the predicate. */
  valid: boolean;
  /** The first property schema the path resolved to, even if it failed the predicate. */
  match?: Located;
}

/** Walks `path` through object schemas starting at `schema`. */
export function findSchemaProperty(ctx: Ctx, schema: Located | undefined, path: string[]): Located | undefined {
  let current = schema;
  for (const segment of path) {
    if (current === undefined || !isObjectSchema(ctx, current)) {
      return undefined;
    }
    const property = collectProperties(ctx, current).find((candidate) => candidate.key === segment);
    if (property === undefined) {
      return undefined;
    }
    current = resolveNode(ctx, property.schema.node, property.schema.location);
  }
  return current;
}

function evaluate(ctx: Ctx, candidates: (Located | undefined)[], predicate: SchemaPredicate): PropertyLookup {
  const found = candidates.filter((candidate): candidate is Located => candidate !== undefined);
  return {
    valid: found.some((candidate) => predicate(ctx, candidate)),
    match: found[0],
  };
}

const FORM_MEDIA_TYPES = ['multipart/form-data', 'application/x-www-form-urlencoded'];

/**
 * The schema of the request body Fern imports: JSON first, then multipart form data, then
 * URL-encoded form data.
 */
export function getRequestBodySchema(ctx: Ctx, operation: OperationInfo): Located | undefined {
  const requestBody = getRequestBody(ctx, operation);
  const json = getJsonMediaType(ctx, requestBody);
  if (json !== undefined) {
    return schemaOfMediaType(json);
  }
  for (const mediaType of FORM_MEDIA_TYPES) {
    const media = getMediaType(ctx, requestBody, mediaType);
    if (media !== undefined) {
      return schemaOfMediaType(media);
    }
  }
  return undefined;
}

function queryParameterSchema(ctx: Ctx, operation: OperationInfo, name: string): Located | undefined {
  const parameter = operation.parameters.find((candidate) => candidate.in === 'query' && candidate.name === name);
  if (parameter === undefined) {
    return undefined;
  }
  if (parameter.node.schema !== undefined) {
    return resolveNode(ctx, parameter.node.schema, parameter.location.child('schema'));
  }
  const content = parameter.node.content;
  if (isPlainObject(content)) {
    const mediaType = Object.keys(content)[0];
    if (mediaType !== undefined) {
      const media = resolveNode(ctx, content[mediaType], parameter.location.child(['content', mediaType]));
      if (media !== undefined && media.node?.schema !== undefined) {
        return resolveNode(ctx, media.node.schema, media.location.child('schema'));
      }
    }
  }
  return undefined;
}

/** Resolves a request property path (without the `$request.` prefix). */
export function lookupRequestProperty(
  ctx: Ctx,
  operation: OperationInfo,
  path: string[],
  predicate: SchemaPredicate,
): PropertyLookup {
  const candidates: (Located | undefined)[] = [];
  if (path.length === 1) {
    candidates.push(queryParameterSchema(ctx, operation, path[0]!));
  }
  candidates.push(findSchemaProperty(ctx, getRequestBodySchema(ctx, operation), path));
  return evaluate(ctx, candidates, predicate);
}

/** Resolves a response property path (without the `$response.` prefix) inside `schema`. */
export function lookupResponseProperty(
  ctx: Ctx,
  schema: Located | undefined,
  path: string[],
  predicate: SchemaPredicate,
): PropertyLookup {
  return evaluate(ctx, [findSchemaProperty(ctx, schema, path)], predicate);
}

/** How `x-fern-streaming` turns an operation into a streaming endpoint, per Fern's importer. */
export type StreamingMode = 'stream' | 'stream-condition' | undefined;

export function streamingMode(operation: AnyNode): StreamingMode {
  const streaming = isPlainObject(operation) ? operation['x-fern-streaming'] : undefined;
  if (streaming === true) {
    return 'stream';
  }
  if (!isPlainObject(streaming)) {
    return undefined;
  }
  if (streaming['stream-condition'] != null) {
    return 'stream-condition';
  }
  return streaming.format != null ? 'stream' : undefined;
}

/** The response Fern imports for an operation. */
export type FernResponse =
  | {
      kind: 'json';
      /** The success response object. */
      response: Located;
      /** The JSON schema; undefined when the media type has no schema. */
      schema: Located | undefined;
    }
  | {
      kind: 'none';
      /** Why there is no JSON response. */
      reason: 'streaming' | 'no-success-response' | 'no-json-content';
      response?: Located;
    };

/**
 * The JSON success response of a non-streaming operation. Streaming operations (`x-fern-streaming`)
 * import as `response-stream` instead, so they have no response.
 */
export function getFernResponse(ctx: Ctx, operation: OperationInfo): FernResponse {
  if (streamingMode(operation.node) !== undefined) {
    return { kind: 'none', reason: 'streaming' };
  }
  const response = getSuccessResponse(ctx, operation);
  if (response === undefined) {
    return { kind: 'none', reason: 'no-success-response' };
  }
  const media = getJsonMediaType(ctx, response);
  if (media === undefined) {
    return { kind: 'none', reason: 'no-json-content', response };
  }
  return { kind: 'json', response, schema: schemaOfMediaType(media) };
}

/** Human-readable explanation of a missing response, for messages. */
export function describeMissingResponse(reason: Extract<FernResponse, { kind: 'none' }>['reason']): string {
  switch (reason) {
    case 'streaming':
      return 'the operation streams its response (x-fern-streaming), so it has no regular response';
    case 'no-success-response':
      return 'the operation has no 200, 201, 202, 204 or default response';
    case 'no-json-content':
      return 'its success response has no JSON content';
  }
}

/** Whether Fern skips the operation entirely (`x-fern-ignore: true`). */
export function isIgnored(operation: AnyNode): boolean {
  return isPlainObject(operation) && operation['x-fern-ignore'] === true;
}
