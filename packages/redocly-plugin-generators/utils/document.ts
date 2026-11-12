import { isPlainObject, resolveChild, resolveNode } from './resolve.ts';
import type { AnyNode, Located, Location, UserContext } from './types.ts';

type Ctx = Pick<UserContext, 'resolve'>;

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace', 'query'] as const;

export interface ParameterInfo {
  name: string;
  in: string;
  /** The resolved parameter object. */
  node: AnyNode;
  location: Location;
  /** Where the parameter was declared. */
  level: 'path' | 'operation';
}

export interface OperationInfo {
  /** The `paths` key, or the webhook name for webhooks. */
  path: string;
  method: string;
  kind: 'path' | 'webhook';
  node: AnyNode;
  location: Location;
  pathItem: Located;
  /** Effective parameters: operation-level parameters override path-level ones by `in` + `name`. */
  parameters: ParameterInfo[];
  /** Path-level and operation-level parameters before merging. */
  allParameters: ParameterInfo[];
}

function collectParameters(ctx: Ctx, container: Located, level: ParameterInfo['level']): ParameterInfo[] {
  const parameters = container.node?.parameters;
  if (!Array.isArray(parameters)) {
    return [];
  }
  const result: ParameterInfo[] = [];
  parameters.forEach((parameter, index) => {
    const resolved = resolveNode(ctx, parameter, container.location.child(['parameters', index]));
    if (resolved === undefined || !isPlainObject(resolved.node)) {
      return;
    }
    if (typeof resolved.node.name !== 'string' || typeof resolved.node.in !== 'string') {
      return;
    }
    result.push({
      name: resolved.node.name,
      in: resolved.node.in,
      node: resolved.node,
      location: resolved.location,
      level,
    });
  });
  return result;
}

function operationsOfPathItem(ctx: Ctx, path: string, pathItem: Located, kind: OperationInfo['kind']): OperationInfo[] {
  if (!isPlainObject(pathItem.node)) {
    return [];
  }
  const pathParameters = collectParameters(ctx, pathItem, 'path');
  const result: OperationInfo[] = [];
  for (const method of HTTP_METHODS) {
    const operation = resolveChild(ctx, pathItem, method);
    if (operation === undefined || !isPlainObject(operation.node)) {
      continue;
    }
    const operationParameters = collectParameters(ctx, operation, 'operation');
    const overridden = new Set(operationParameters.map((parameter) => `${parameter.in}:${parameter.name}`));
    result.push({
      path,
      method,
      kind,
      node: operation.node,
      location: operation.location,
      pathItem,
      parameters: [
        ...pathParameters.filter((parameter) => !overridden.has(`${parameter.in}:${parameter.name}`)),
        ...operationParameters,
      ],
      allParameters: [...pathParameters, ...operationParameters],
    });
  }
  return result;
}

interface OperationsCache {
  paths?: OperationInfo[];
  withWebhooks?: OperationInfo[];
}

// Rules share this cache for the duration of a single lint pass: the root node is a stable
// reference across rules in one pass, so a WeakMap keyed on it dedupes the paths/webhooks walk
// (and its resolveChild / collectParameters calls) that would otherwise repeat per rule.
const operationsCache = new WeakMap<object, OperationsCache>();

function computeOperations(ctx: Ctx, root: Located, includeWebhooks: boolean): OperationInfo[] {
  const result: OperationInfo[] = [];
  const paths = resolveChild(ctx, root, 'paths');
  if (paths !== undefined && isPlainObject(paths.node)) {
    for (const path of Object.keys(paths.node)) {
      if (path.startsWith('x-')) {
        continue;
      }
      const pathItem = resolveChild(ctx, paths, path);
      if (pathItem !== undefined) {
        result.push(...operationsOfPathItem(ctx, path, pathItem, 'path'));
      }
    }
  }
  if (includeWebhooks) {
    const webhooks = resolveChild(ctx, root, 'webhooks');
    if (webhooks !== undefined && isPlainObject(webhooks.node)) {
      for (const name of Object.keys(webhooks.node)) {
        const pathItem = resolveChild(ctx, webhooks, name);
        if (pathItem !== undefined) {
          result.push(...operationsOfPathItem(ctx, name, pathItem, 'webhook'));
        }
      }
    }
  }
  return result;
}

function freezeOperations(operations: OperationInfo[]): OperationInfo[] {
  for (const operation of operations) {
    for (const parameter of operation.allParameters) {
      Object.freeze(parameter);
    }
    for (const parameter of operation.parameters) {
      Object.freeze(parameter);
    }
    Object.freeze(operation.parameters);
    Object.freeze(operation.allParameters);
    Object.freeze(operation);
  }
  return Object.freeze(operations) as OperationInfo[];
}

/** All operations under `paths` (and, optionally, OAS 3.1 `webhooks`), with `$ref`s resolved. */
export function getOperations(ctx: Ctx, root: Located, options: { includeWebhooks?: boolean } = {}): OperationInfo[] {
  const includeWebhooks = options.includeWebhooks === true;
  if (!isPlainObject(root.node)) {
    return computeOperations(ctx, root, includeWebhooks);
  }
  let cached = operationsCache.get(root.node);
  if (cached === undefined) {
    cached = {};
    operationsCache.set(root.node, cached);
  }
  if (includeWebhooks) {
    return (cached.withWebhooks ??= freezeOperations(computeOperations(ctx, root, true)));
  }
  return (cached.paths ??= freezeOperations(computeOperations(ctx, root, false)));
}

/** `GET /path` style label used in messages. */
export function operationLabel(operation: Pick<OperationInfo, 'method' | 'path'>): string {
  return `${operation.method.toUpperCase()} ${operation.path}`;
}

/** Fern's endpoint id for messages: the operationId when present, otherwise `METHOD /path`. */
export function endpointId(operation: OperationInfo): string {
  return typeof operation.node.operationId === 'string' ? operation.node.operationId : operationLabel(operation);
}

// Fern's JSON media type test: any media type containing "json", or the "*/*" wildcard.
export function isJsonMediaType(mediaType: string): boolean {
  return mediaType.includes('json') || mediaType === '*/*';
}

/** The first JSON media type entry of a `content` map, in document order (as Fern picks it). */
export function getJsonMediaType(
  ctx: Ctx,
  container: Located | undefined,
): (Located & { mediaType: string }) | undefined {
  const content = container === undefined ? undefined : resolveChild(ctx, container, 'content');
  if (content === undefined || !isPlainObject(content.node)) {
    return undefined;
  }
  const mediaType = Object.keys(content.node).find(isJsonMediaType);
  if (mediaType === undefined) {
    return undefined;
  }
  const resolved = resolveChild(ctx, content, mediaType);
  return resolved === undefined ? undefined : { ...resolved, mediaType };
}

export function getMediaType(ctx: Ctx, container: Located | undefined, mediaType: string): Located | undefined {
  const content = container === undefined ? undefined : resolveChild(ctx, container, 'content');
  if (content === undefined || !isPlainObject(content.node)) {
    return undefined;
  }
  const key = Object.keys(content.node).find(
    (candidate) => candidate.split(';')[0]!.trim().toLowerCase() === mediaType,
  );
  return key === undefined ? undefined : resolveChild(ctx, content, key);
}

export function getRequestBody(ctx: Ctx, operation: OperationInfo): Located | undefined {
  return resolveChild(ctx, { node: operation.node, location: operation.location }, 'requestBody');
}

/**
 * The resolved `requestBody.content` map of an operation, or `undefined` when there is no request
 * body, no `content` map, or the content is not a plain object.
 */
export function getRequestBodyContent(ctx: Ctx, operation: OperationInfo): Located | undefined {
  const requestBody = getRequestBody(ctx, operation);
  const content = requestBody === undefined ? undefined : resolveChild(ctx, requestBody, 'content');
  return content !== undefined && isPlainObject(content.node) ? content : undefined;
}

export function schemaOfMediaType(mediaType: Located): Located | undefined {
  if (!isPlainObject(mediaType.node) || mediaType.node.schema === undefined) {
    return undefined;
  }
  return {
    node: mediaType.node.schema,
    location: mediaType.location.child('schema'),
  };
}

export function getResponses(ctx: Ctx, operation: OperationInfo): Located | undefined {
  return resolveChild(ctx, { node: operation.node, location: operation.location }, 'responses');
}

export function getResponse(ctx: Ctx, operation: OperationInfo, statusCode: string): Located | undefined {
  const responses = getResponses(ctx, operation);
  if (responses === undefined || !isPlainObject(responses.node)) {
    return undefined;
  }
  const key = Object.keys(responses.node).find((candidate) => candidate.toUpperCase() === statusCode.toUpperCase());
  return key === undefined ? undefined : resolveChild(ctx, responses, key);
}

const SUCCESS_STATUS_CODES = ['200', '201', '202', '204'];

function hasContent(response: Located): boolean {
  const content = response.node?.content;
  return isPlainObject(content) && Object.keys(content).length > 0;
}

/**
 * The response Fern treats as the endpoint's response: the first of 200, 201, 202 and 204 that
 * declares content (falling back to the first of them that exists), or `default` when none of
 * those status codes are present.
 */
export function getSuccessResponse(ctx: Ctx, operation: OperationInfo): (Located & { statusCode: string }) | undefined {
  const present = SUCCESS_STATUS_CODES.flatMap((statusCode) => {
    const response = getResponse(ctx, operation, statusCode);
    return response === undefined ? [] : [{ ...response, statusCode }];
  });
  if (present.length > 0) {
    return present.find(hasContent) ?? present[0];
  }
  const fallback = getResponse(ctx, operation, 'default');
  return fallback === undefined ? undefined : { ...fallback, statusCode: 'default' };
}

/** Schema of the JSON success response, if any. */
export function getJsonResponseSchema(ctx: Ctx, operation: OperationInfo): Located | undefined {
  const mediaType = getJsonMediaType(ctx, getSuccessResponse(ctx, operation));
  return mediaType === undefined ? undefined : schemaOfMediaType(mediaType);
}

/** The root of the document as a {@link Located}. */
export function rootOf(root: AnyNode, ctx: Pick<UserContext, 'location'>): Located {
  return { node: root, location: ctx.location };
}
