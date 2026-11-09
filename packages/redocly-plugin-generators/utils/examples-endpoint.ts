import { endpointId, getOperations, type OperationInfo } from './document.ts';
import { isPlainObject, isRefNode, resolveChild, resolveNode } from './resolve.ts';
import { collectProperties, isObjectSchema, schemaTypes } from './schema.ts';
import {
  buildRequestWrapper,
  documentFacts,
  type RefOccurrence,
  type RequestWrapper,
} from './naming-request-wrapper.ts';
import type { AnyNode, Located, UserContext } from './types.ts';

/**
 * Models the endpoint Fern's OpenAPI importer generates for each operation, as far as
 * `x-fern-examples` validation needs it: which headers, path and query parameters an example
 * must or may list (after Fern strips auth headers, adds global headers and renames colliding
 * path parameters), the request body, the response Fern picks and the errors it declares.
 */

type Ctx = Pick<UserContext, 'resolve'>;

export type ParameterKind = 'header' | 'path parameter' | 'query parameter';

export interface ParameterDeclaration {
  kind: ParameterKind;
  /** The key the example must use. */
  key: string;
  /** Other keys Fern may use for this parameter (when a rename cannot be decided statically). */
  alternateKeys: string[];
  required: boolean;
  /** Schema to validate example values against (the item schema for list query parameters). */
  schema?: Located;
  /** A standalone JSON schema to validate against, for declarations without a document schema. */
  standalone?: Record<string, unknown>;
  /** List query parameters accept a single value or a list of values. */
  allowMultiple: boolean;
  /** Fern turns a header's string `default` into a constant the example must match. */
  literal?: string;
  /** Explains where the declaration comes from, appended to messages. */
  origin?: string;
}

export type RequestModel =
  | { kind: 'none' }
  | { kind: 'other' }
  | {
      kind: 'json' | 'form' | 'multipart';
      schema: Located | undefined;
      required: boolean;
      mediaType: string;
    };

export type ResponseModel =
  | { kind: 'none' }
  | { kind: 'other' }
  | { kind: 'skip' }
  | {
      kind: 'json';
      schema: Located | undefined;
      statusCode: string;
      /** Set when a 204 response sits next to the body response, so the body may be omitted. */
      optional: boolean;
    }
  | { kind: 'stream'; format: 'json' | 'sse'; schema: Located | undefined }
  | {
      /**
       * A `stream-condition` operation: Fern generates a streaming endpoint (examples with
       * `response.stream`) and a non-streaming one (other examples; examples without a response
       * apply to both), selected by a boolean request body property.
       */
      kind: 'condition';
      property: string;
      response: Located | undefined;
      stream: Located | undefined;
      format: 'json' | 'sse';
    };

export interface ErrorModel {
  name: string;
  statusCode: string;
  schema: Located | undefined;
  /** Fern types the error body as unknown (no schema, or conflicting schemas across operations). */
  unknown: boolean;
}

export interface EndpointModel {
  operation: OperationInfo;
  parameters: Record<ParameterKind, ParameterDeclaration[]>;
  /** Parameters Fern drops from the endpoint, keyed by kind and example key, with the reason. */
  dropped: Record<ParameterKind, Map<string, string>>;
  request: RequestModel;
  /** Wire keys of `readOnly` properties Fern drops from the inlined request body. */
  droppedReadOnlyKeys: Set<string>;
  response: ResponseModel;
  errors: Map<string, ErrorModel>;
}

export const ERROR_NAMES_BY_STATUS_CODE: Record<number, string> = {
  400: 'BadRequestError',
  401: 'UnauthorizedError',
  402: 'PaymentRequiredError',
  403: 'ForbiddenError',
  404: 'NotFoundError',
  405: 'MethodNotAllowedError',
  406: 'NotAcceptableError',
  407: 'ProxyAuthenticationRequiredError',
  408: 'RequestTimeoutError',
  409: 'ConflictError',
  410: 'GoneError',
  411: 'LengthRequiredError',
  412: 'PreconditionFailedError',
  413: 'ContentTooLargeError',
  414: 'URITooLongError',
  415: 'UnsupportedMediaTypeError',
  416: 'RangeNotSatisfiableError',
  417: 'ExpectationFailedError',
  418: 'ImATeapotError',
  419: 'AuthenticationTimeoutError',
  420: 'MethodFailureError',
  421: 'MisdirectedRequestError',
  422: 'UnprocessableEntityError',
  423: 'LockedError',
  424: 'FailedDependencyError',
  425: 'TooEarlyError',
  426: 'UpgradeRequiredError',
  428: 'PreconditionError',
  429: 'TooManyRequestsError',
  430: 'RequestHeaderFieldsTooLargeError',
  431: 'RequestHeaderFieldsTooLargeError',
  444: 'NoResponseError',
  449: 'RetryWithError',
  450: 'BlockedByWindowsParentalControlsError',
  451: 'UnavailableForLegalReasonsError',
  498: 'InvalidTokenError',
  499: 'ClientClosedRequestError',
  500: 'InternalServerError',
  501: 'NotImplementedError',
  502: 'BadGatewayError',
  503: 'ServiceUnavailableError',
  504: 'GatewayTimeoutError',
  505: 'HTTPVersionNotSupportedError',
  506: 'VariantAlsoNegotiatesError',
  507: 'InsufficientStorageError',
  508: 'LoopDetectedError',
  509: 'BandwidthLimitExceededError',
  510: 'NotExtendedError',
  511: 'NetworkAuthenticationRequiredError',
};

const WILDCARD_ERROR_NAMES: Record<string, string> = {
  '4XX': 'ClientRequestError',
  '5XX': 'ServerError',
};

/** Header parameters Fern's importer never turns into endpoint headers. */
const HEADERS_TO_SKIP = new Set([
  'user-agent',
  'content-length',
  'content-type',
  'x-forwarded-for',
  'cookie',
  'origin',
  'content-disposition',
  'x-ping-custom-domain',
]);

const GLOBAL_HEADER_THRESHOLD = 0.75;
const SUCCESS_STATUS_CODES = ['200', '201', '202', '204'];
const TYPE_KEYWORDS = [
  'type',
  'properties',
  'items',
  'additionalProperties',
  'allOf',
  'oneOf',
  'anyOf',
  'enum',
  'const',
  'not',
  '$ref',
  'x-fern-type',
];

/** Whether Fern imports the schema as `unknown` (any value, optional). */
export function isUnknownSchema(ctx: Ctx, located: Located | undefined): boolean {
  if (located === undefined) {
    return true;
  }
  const resolved = resolveNode(ctx, located.node, located.location);
  if (resolved === undefined) {
    return false;
  }
  if (resolved.node === true) {
    return true;
  }
  return isPlainObject(resolved.node) && TYPE_KEYWORDS.every((keyword) => resolved.node[keyword] === undefined);
}

/** Whether the (resolved) schema allows null, which Fern imports as `nullable<...>`. */
function isNullableSchema(ctx: Ctx, located: Located | undefined): boolean {
  if (located === undefined) {
    return false;
  }
  const resolved = resolveNode(ctx, located.node, located.location);
  if (resolved === undefined || !isPlainObject(resolved.node)) {
    return false;
  }
  if (schemaTypes(resolved.node).includes('null')) {
    return true;
  }
  for (const union of ['oneOf', 'anyOf']) {
    const members = resolved.node[union];
    if (Array.isArray(members)) {
      const hasNull = members.some((member: AnyNode, index: number) => {
        const memberResolved = resolveNode(ctx, member, resolved.location.child([union, index]));
        const types = schemaTypes(memberResolved?.node);
        return types.length === 1 && types[0] === 'null';
      });
      if (hasNull) {
        return true;
      }
    }
  }
  return false;
}

function schemaOf(parent: Located): Located | undefined {
  if (!isPlainObject(parent.node) || parent.node.schema === undefined) {
    return undefined;
  }
  return {
    node: parent.node.schema,
    location: parent.location.child('schema'),
  };
}

function isIgnored(node: AnyNode): boolean {
  return isPlainObject(node) && node['x-fern-ignore'] === true;
}

interface SecurityInfo {
  /** Header parameter names Fern's importer drops (exact match). */
  authHeaders: Set<string>;
  /** The header Fern's builder treats as the auth header. */
  authHeaderName: string | undefined;
  /** API key headers that Fern declares as required global headers. */
  globalHeaders: ParameterDeclaration[];
}

function securityInfo(ctx: Ctx, root: Located): SecurityInfo {
  const info: SecurityInfo = {
    authHeaders: new Set(),
    authHeaderName: undefined,
    globalHeaders: [],
  };
  const components = resolveChild(ctx, root, 'components');
  const schemes = components === undefined ? undefined : resolveChild(ctx, components, 'securitySchemes');
  if (schemes === undefined || !isPlainObject(schemes.node)) {
    return info;
  }
  let authSet = false;
  let hasAuthScheme = false;
  let firstHeaderScheme: string | undefined;
  for (const id of Object.keys(schemes.node)) {
    const scheme = resolveChild(ctx, schemes, id)?.node;
    if (!isPlainObject(scheme)) {
      continue;
    }
    const httpScheme = typeof scheme.scheme === 'string' ? scheme.scheme.toLowerCase() : '';
    const isBearerLike =
      (scheme.type === 'http' && (httpScheme === 'bearer' || httpScheme === 'basic')) ||
      scheme.type === 'oauth2' ||
      scheme.type === 'openIdConnect';
    if (isBearerLike) {
      info.authHeaders.add('Authorization');
      hasAuthScheme = true;
      authSet = true;
    } else if (scheme.type === 'apiKey' && scheme.in === 'header' && typeof scheme.name === 'string') {
      info.authHeaders.add(scheme.name);
      if (!authSet) {
        firstHeaderScheme = scheme.name;
        hasAuthScheme = true;
        authSet = true;
      } else {
        info.globalHeaders.push({
          kind: 'header',
          key: scheme.name,
          alternateKeys: [],
          required: true,
          standalone: { type: 'string' },
          allowMultiple: false,
          origin: `Fern adds the API key security scheme "${id}" as a global header because another security scheme comes first`,
        });
      }
    }
  }
  info.authHeaderName = firstHeaderScheme ?? (hasAuthScheme ? 'Authorization' : undefined);
  return info;
}

/** JSON schema for a Fern type string used in `x-fern-global-headers[].type`. */
function fernTypeSchema(type: string): {
  schema?: Record<string, unknown>;
  optional: boolean;
} {
  const wrapper = /^(optional|nullable)<(.+)>$/.exec(type.trim());
  if (wrapper !== null) {
    return { ...fernTypeSchema(wrapper[2]!), optional: true };
  }
  const literal = /^literal<\s*"(.*)"\s*>$/.exec(type.trim());
  if (literal !== null) {
    return { schema: { const: literal[1] }, optional: false };
  }
  const schemas: Record<string, Record<string, unknown>> = {
    string: { type: 'string' },
    integer: { type: 'integer' },
    long: { type: 'integer' },
    uint: { type: 'integer' },
    uint64: { type: 'integer' },
    double: { type: 'number' },
    float: { type: 'number' },
    boolean: { type: 'boolean' },
    uuid: { type: 'string', format: 'uuid' },
    datetime: { type: 'string', format: 'date-time' },
    date: { type: 'string', format: 'date' },
    base64: { type: 'string' },
  };
  return { schema: schemas[type.trim()], optional: false };
}

function extensionGlobalHeaders(root: Located): ParameterDeclaration[] {
  const raw = isPlainObject(root.node) ? root.node['x-fern-global-headers'] : undefined;
  if (!Array.isArray(raw)) {
    return [];
  }
  const result: ParameterDeclaration[] = [];
  for (const header of raw) {
    if (!isPlainObject(header) || typeof header.header !== 'string') {
      continue;
    }
    let required = header.optional !== true;
    let standalone: Record<string, unknown> | undefined = { type: 'string' };
    if (typeof header.type === 'string') {
      const parsed = fernTypeSchema(header.type);
      required = !parsed.optional;
      standalone = parsed.schema;
    }
    result.push({
      kind: 'header',
      key: header.header,
      alternateKeys: [],
      required,
      ...(standalone === undefined ? {} : { standalone }),
      allowMultiple: false,
      origin: 'declared in x-fern-global-headers',
    });
  }
  return result;
}

interface RawParameter {
  name: string;
  node: AnyNode;
  location: Located['location'];
}

function parameterDeclaration(ctx: Ctx, kind: ParameterKind, parameter: RawParameter): ParameterDeclaration {
  const schema = schemaOf({
    node: parameter.node,
    location: parameter.location,
  });
  const declaration: ParameterDeclaration = {
    kind,
    key: parameter.name,
    alternateKeys: [],
    required: false,
    allowMultiple: false,
  };
  if (schema === undefined) {
    declaration.required = parameter.node.required === true;
    if (parameter.node.content === undefined) {
      declaration.standalone = { type: 'string' };
    }
    return declaration;
  }
  if (
    kind === 'header' &&
    isPlainObject(schema.node) &&
    !isRefNode(schema.node) &&
    typeof schema.node.default === 'string' &&
    schema.node.default.length > 0
  ) {
    declaration.required = true;
    declaration.literal = schema.node.default;
    return declaration;
  }
  const resolved = resolveNode(ctx, schema.node, schema.location);
  if (
    kind === 'query parameter' &&
    resolved !== undefined &&
    isPlainObject(resolved.node) &&
    schemaTypes(resolved.node).includes('array')
  ) {
    declaration.allowMultiple = true;
    declaration.required = false;
    if (resolved.node.items !== undefined) {
      declaration.schema = {
        node: resolved.node.items,
        location: resolved.location.child('items'),
      };
    }
    return declaration;
  }
  declaration.required =
    parameter.node.required === true && !isNullableSchema(ctx, schema) && !isUnknownSchema(ctx, schema);
  if (!(kind === 'path parameter' && parameter.node['x-fern-sdk-variable'] !== undefined)) {
    declaration.schema = schema;
  }
  return declaration;
}

interface IntermediateEndpoint {
  operation: OperationInfo;
  headers: { declaration: ParameterDeclaration; nameOverride?: string }[];
  path: { parameter: RawParameter; declaration: ParameterDeclaration }[];
  query: ParameterDeclaration[];
  dropped: Record<ParameterKind, Map<string, string>>;
  request: RequestModel;
  requestMedia: Located | undefined;
}

function firstMediaKey(
  content: Record<string, AnyNode>,
  predicate: (mediaType: string) => boolean,
): string | undefined {
  return Object.keys(content).find((mediaType) => predicate(mediaType.toLowerCase()));
}

function isJsonish(mediaType: string): boolean {
  return mediaType.includes('json') || mediaType === '*/*';
}

function requestModel(ctx: Ctx, operation: OperationInfo): { model: RequestModel; media: Located | undefined } {
  const body = resolveChild(ctx, { node: operation.node, location: operation.location }, 'requestBody');
  if (body === undefined || !isPlainObject(body.node)) {
    return { model: { kind: 'none' }, media: undefined };
  }
  const content = resolveChild(ctx, body, 'content');
  if (content === undefined || !isPlainObject(content.node)) {
    return { model: { kind: 'none' }, media: undefined };
  }
  const required = body.node.required === true;
  if (firstMediaKey(content.node, (type) => type.includes('octet-stream'))) {
    return { model: { kind: 'other' }, media: undefined };
  }
  const jsonKey = firstMediaKey(content.node, isJsonish);
  const multipartKey = firstMediaKey(content.node, (type) => type.startsWith('multipart/form-data'));
  const json = jsonKey === undefined ? undefined : resolveChild(ctx, content, jsonKey);
  const multipart = multipartKey === undefined ? undefined : resolveChild(ctx, content, multipartKey);
  const jsonHasSchema = isPlainObject(json?.node) && json.node.schema !== undefined;
  const multipartHasSchema = isPlainObject(multipart?.node) && multipart.node.schema !== undefined;
  if (jsonHasSchema) {
    return {
      model: {
        kind: 'json',
        schema: schemaOf(json!),
        required,
        mediaType: jsonKey!,
      },
      media: json,
    };
  }
  if (multipartHasSchema) {
    return {
      model: {
        kind: 'multipart',
        schema: schemaOf(multipart!),
        required,
        mediaType: multipartKey!,
      },
      media: multipart,
    };
  }
  if (
    json !== undefined &&
    isPlainObject(json.node) &&
    (json.node.example !== undefined ||
      (isPlainObject(json.node.examples) && Object.keys(json.node.examples).length > 0))
  ) {
    return {
      model: { kind: 'json', schema: undefined, required, mediaType: jsonKey! },
      media: json,
    };
  }
  const formKey = firstMediaKey(content.node, (type) => type.startsWith('application/x-www-form-urlencoded'));
  if (formKey !== undefined) {
    const form = resolveChild(ctx, content, formKey);
    if (form !== undefined) {
      return {
        model: {
          kind: 'form',
          schema: schemaOf(form),
          required,
          mediaType: formKey,
        },
        media: form,
      };
    }
  }
  return { model: { kind: 'none' }, media: undefined };
}

type StreamFormat = 'json' | 'sse' | 'condition' | undefined;

function hasSoleEventStream(ctx: Ctx, response: Located): boolean {
  const content = resolveChild(ctx, response, 'content');
  if (content === undefined || !isPlainObject(content.node)) {
    return false;
  }
  const keys = Object.keys(content.node);
  return keys.length === 1 && keys[0]!.includes('text/event-stream');
}

function streamFormat(ctx: Ctx, operation: OperationInfo): StreamFormat {
  const streaming = operation.node['x-fern-streaming'];
  if (streaming === true) {
    return 'json';
  }
  if (isPlainObject(streaming)) {
    if (streaming['stream-condition'] !== undefined) {
      return 'condition';
    }
    if (streaming.format === 'sse' || streaming.format === 'json') {
      return streaming.format;
    }
  }
  const responses = resolveChild(ctx, { node: operation.node, location: operation.location }, 'responses');
  if (responses === undefined || !isPlainObject(responses.node)) {
    return undefined;
  }
  for (const statusCode of Object.keys(responses.node)) {
    const code = Number.parseInt(statusCode, 10);
    if (Number.isNaN(code) || code < 200 || code >= 300) {
      continue;
    }
    const response = resolveChild(ctx, responses, statusCode);
    if (response !== undefined && hasSoleEventStream(ctx, response)) {
      return 'sse';
    }
  }
  return undefined;
}

function isBinarySchema(ctx: Ctx, media: Located): boolean {
  const schema = schemaOf(media);
  if (schema === undefined) {
    return false;
  }
  const resolved = resolveNode(ctx, schema.node, schema.location)?.node;
  return (
    isPlainObject(resolved) &&
    resolved.type === 'string' &&
    (resolved.format === 'binary' ||
      (resolved.format === undefined && resolved.contentMediaType === 'application/octet-stream'))
  );
}

function convertResponse(
  ctx: Ctx,
  response: Located,
  statusCode: string,
  stream: 'json' | 'sse' | undefined,
): ResponseModel | undefined {
  const content = resolveChild(ctx, response, 'content');
  if (content === undefined || !isPlainObject(content.node)) {
    return undefined;
  }
  const media = Object.keys(content.node).map((key) => ({
    key,
    located: resolveChild(ctx, content, key),
  }));
  if (media.some(({ located }) => located !== undefined && isBinarySchema(ctx, located))) {
    return { kind: 'other' };
  }
  const eventStream = media.find(({ key }) => key.includes('text/event-stream'));
  if (eventStream?.located !== undefined && stream !== undefined) {
    const node = eventStream.located.node;
    const schema = isPlainObject(node)
      ? node.schema !== undefined
        ? schemaOf(eventStream.located)
        : node.itemSchema !== undefined
          ? {
              node: node.itemSchema,
              location: eventStream.located.location.child('itemSchema'),
            }
          : undefined
      : undefined;
    return { kind: 'stream', format: stream, schema };
  }
  const json = media.find(({ key }) => isJsonish(key.toLowerCase()));
  if (json?.located !== undefined) {
    const schema = schemaOf(json.located);
    if (stream !== undefined) {
      return { kind: 'stream', format: stream, schema };
    }
    return { kind: 'json', schema, statusCode, optional: false };
  }
  for (const { key } of media) {
    const type = key.toLowerCase();
    if (
      type.includes('octet-stream') ||
      type.includes('pdf') ||
      type.startsWith('audio/') ||
      type.startsWith('image/') ||
      type.startsWith('video/') ||
      type.startsWith('multipart/mixed')
    ) {
      return { kind: 'other' };
    }
    if (type.startsWith('text/') && !type.includes('event-stream')) {
      return { kind: 'other' };
    }
  }
  return undefined;
}

function conditionModel(operation: OperationInfo): ResponseModel {
  const streaming = operation.node['x-fern-streaming'];
  const condition = streaming['stream-condition'];
  if (typeof condition !== 'string') {
    return { kind: 'skip' };
  }
  const property = condition.startsWith('$request.') ? condition.slice('$request.'.length) : condition;
  const located = (key: string): Located | undefined =>
    streaming[key] == null
      ? undefined
      : {
          node: streaming[key],
          location: operation.location.child(['x-fern-streaming', key]),
        };
  return {
    kind: 'condition',
    property,
    response: located('response'),
    stream: located('response-stream'),
    format: streaming.format === 'sse' ? 'sse' : 'json',
  };
}

function responseModel(ctx: Ctx, operation: OperationInfo): ResponseModel {
  const format = streamFormat(ctx, operation);
  if (format === 'condition') {
    return conditionModel(operation);
  }
  const responses = resolveChild(ctx, { node: operation.node, location: operation.location }, 'responses');
  if (responses === undefined || !isPlainObject(responses.node)) {
    return { kind: 'none' };
  }
  let converted: ResponseModel | undefined;
  let successPresent = false;
  let noContent = false;
  for (const statusCode of SUCCESS_STATUS_CODES) {
    if (responses.node[statusCode] === undefined) {
      continue;
    }
    successPresent = true;
    const response = resolveChild(ctx, responses, statusCode);
    if (converted === undefined) {
      converted = response === undefined ? undefined : convertResponse(ctx, response, statusCode, format);
      if (converted === undefined && statusCode === '204') {
        noContent = true;
      }
    } else if (statusCode === '204') {
      noContent = true;
    }
  }
  if (noContent && converted?.kind === 'json') {
    converted = { ...converted, optional: true };
  }
  if (converted === undefined && !successPresent && responses.node.default !== undefined) {
    const response = resolveChild(ctx, responses, 'default');
    converted = response === undefined ? undefined : convertResponse(ctx, response, 'default', format);
  }
  return converted ?? { kind: 'none' };
}

interface RawError {
  name: string;
  statusCode: string;
  conflictKey: string;
  schema: Located | undefined;
  signature: string;
}

function rawErrors(ctx: Ctx, operation: OperationInfo): RawError[] {
  const responses = resolveChild(ctx, { node: operation.node, location: operation.location }, 'responses');
  if (responses === undefined || !isPlainObject(responses.node)) {
    return [];
  }
  const result: RawError[] = [];
  for (const statusCode of Object.keys(responses.node)) {
    if (statusCode === 'default') {
      continue;
    }
    const wildcard = WILDCARD_ERROR_NAMES[statusCode.toUpperCase()];
    const code = wildcard !== undefined ? undefined : Number.parseInt(statusCode, 10);
    if (code !== undefined && (Number.isNaN(code) || code < 400 || code > 600)) {
      continue;
    }
    const name = wildcard ?? ERROR_NAMES_BY_STATUS_CODE[code!];
    if (name === undefined) {
      continue;
    }
    const response = resolveChild(ctx, responses, statusCode);
    const content = response === undefined ? undefined : resolveChild(ctx, response, 'content');
    let schema: Located | undefined;
    if (content !== undefined && isPlainObject(content.node)) {
      const first = Object.keys(content.node)[0];
      const media = first === undefined ? undefined : resolveChild(ctx, content, first);
      schema = media === undefined ? undefined : schemaOf(media);
    }
    let signature = '{}';
    if (schema !== undefined) {
      signature = isRefNode(schema.node)
        ? (resolveNode(ctx, schema.node, schema.location)?.location.absolutePointer ?? schema.node.$ref)
        : JSON.stringify(schema.node);
    }
    result.push({
      name,
      statusCode: wildcard !== undefined ? statusCode.toUpperCase() : String(code),
      // Fern keys error schemas by the parsed status code, so 4XX and 5XX share a key.
      conflictKey: String(Number.parseInt(statusCode, 10)),
      schema,
      signature,
    });
  }
  return result;
}

function requestPropertyNames(
  ctx: Ctx,
  request: RequestModel,
  media: Located | undefined,
): { certain: Set<string>; ambiguous: Set<string> } {
  const certain = new Set<string>();
  const ambiguous = new Set<string>();
  if (request.kind === 'none' || media === undefined) {
    return { certain, ambiguous };
  }
  const schema = schemaOf(media);
  if (schema === undefined) {
    return { certain, ambiguous };
  }
  const propertyNames = (): string[] =>
    collectProperties(ctx, schema).map((property) => {
      const resolved = resolveNode(ctx, property.schema.node, property.schema.location);
      const override = isPlainObject(property.schema.node) ? property.schema.node['x-fern-property-name'] : undefined;
      const resolvedOverride = isPlainObject(resolved?.node) ? resolved.node['x-fern-property-name'] : undefined;
      const name = override ?? resolvedOverride;
      return typeof name === 'string' ? name : property.key;
    });
  const objectLike = isObjectSchema(ctx, schema) && !isNullableSchema(ctx, schema);
  if (request.kind === 'multipart') {
    if (!isRefNode(schema.node) && objectLike) {
      propertyNames().forEach((name) => certain.add(name));
    }
    return { certain, ambiguous };
  }
  if (!objectLike) {
    certain.add('body');
  } else if (isRefNode(schema.node)) {
    // Whether Fern inlines a referenced body depends on where else the schema is used.
    propertyNames().forEach((name) => ambiguous.add(name));
    ambiguous.add('body');
  } else {
    propertyNames().forEach((name) => certain.add(name));
  }
  return { certain, ambiguous };
}

function intermediateEndpoint(ctx: Ctx, operation: OperationInfo, security: SecurityInfo): IntermediateEndpoint {
  const dropped: Record<ParameterKind, Map<string, string>> = {
    header: new Map(),
    'path parameter': new Map(),
    'query parameter': new Map(),
  };
  const headers: IntermediateEndpoint['headers'] = [];
  const path: IntermediateEndpoint['path'] = [];
  const query: ParameterDeclaration[] = [];
  for (const parameter of operation.parameters) {
    const raw: RawParameter = {
      name: parameter.name,
      node: parameter.node,
      location: parameter.location,
    };
    if (isIgnored(parameter.node)) {
      const kind: ParameterKind | undefined =
        parameter.in === 'header'
          ? 'header'
          : parameter.in === 'path'
            ? 'path parameter'
            : parameter.in === 'query'
              ? 'query parameter'
              : undefined;
      if (kind !== undefined) {
        dropped[kind].set(parameter.name, 'the parameter has x-fern-ignore');
      }
      continue;
    }
    if (parameter.in === 'header') {
      if (HEADERS_TO_SKIP.has(parameter.name.toLowerCase())) {
        dropped.header.set(parameter.name, `Fern never imports ${parameter.name} header parameters`);
        continue;
      }
      if (security.authHeaders.has(parameter.name)) {
        dropped.header.set(
          parameter.name,
          'Fern sets authentication headers from components.securitySchemes and drops them from operations',
        );
        continue;
      }
      const override = parameter.node['x-fern-parameter-name'];
      headers.push({
        declaration: parameterDeclaration(ctx, 'header', raw),
        ...(typeof override === 'string' ? { nameOverride: override } : {}),
      });
    } else if (parameter.in === 'path') {
      path.push({
        parameter: raw,
        declaration: parameterDeclaration(ctx, 'path parameter', raw),
      });
    } else if (parameter.in === 'query') {
      query.push(parameterDeclaration(ctx, 'query parameter', raw));
    }
  }
  const { model: request, media: requestMedia } = requestModel(ctx, operation);
  return { operation, headers, path, query, dropped, request, requestMedia };
}

function resolvePathParameterKeys(
  ctx: Ctx,
  endpoint: IntermediateEndpoint,
  wrapper: RequestWrapper | undefined,
): ParameterDeclaration[] {
  const reserved = new Set<string>();
  endpoint.query.forEach((declaration) => reserved.add(declaration.key));
  endpoint.headers.forEach(({ declaration, nameOverride }) => reserved.add(nameOverride ?? declaration.key));
  const kind = endpoint.request.kind;
  const body =
    wrapper?.bodyNames !== undefined && (kind === 'json' || kind === 'form')
      ? { certain: wrapper.bodyNames, ambiguous: new Set<string>() }
      : requestPropertyNames(ctx, endpoint.request, endpoint.requestMedia);
  body.certain.forEach((name) => reserved.add(name));
  const pathNames = endpoint.path.map(({ parameter }) => {
    const override = parameter.node['x-fern-parameter-name'];
    return typeof override === 'string' ? override : parameter.name;
  });
  return endpoint.path.map(({ parameter, declaration }, index) => {
    const override = parameter.node['x-fern-parameter-name'];
    if (typeof override === 'string') {
      return { ...declaration, key: override };
    }
    const certain = reserved.has(parameter.name);
    const maybe = body.ambiguous.has(parameter.name);
    if (!certain && !maybe) {
      return declaration;
    }
    const taken = new Set([...reserved, ...body.ambiguous, ...pathNames.filter((_, other) => other !== index)]);
    let candidate = `${parameter.name}PathParam`;
    for (let counter = 2; taken.has(candidate); counter++) {
      candidate = `${parameter.name}PathParam${counter}`;
    }
    if (certain) {
      endpoint.dropped['path parameter'].set(
        parameter.name,
        `Fern renames this path parameter to "${candidate}" because a query parameter, header or request body property of the operation is also named "${parameter.name}"`,
      );
      return { ...declaration, key: candidate };
    }
    return { ...declaration, alternateKeys: [candidate] };
  });
}

/**
 * The endpoints Fern builds from the document's operations (excluding `x-fern-ignore`d ones).
 * With the document's `$ref` occurrences, request bodies are classified as inlined or
 * referenced the way Fern's importer does, which decides path parameter renames and dropped
 * `readOnly` body properties.
 */
export function buildEndpointModels(ctx: Ctx, root: Located, refs?: RefOccurrence[]): EndpointModel[] {
  const facts = refs === undefined ? undefined : documentFacts(ctx, root, refs);
  const operations = getOperations(ctx, root).filter(
    (operation) => !isIgnored(operation.node) && !isIgnored(operation.pathItem.node),
  );
  const security = securityInfo(ctx, root);
  const predefined = extensionGlobalHeaders(root);
  const intermediates = operations.map((operation) => intermediateEndpoint(ctx, operation, security));

  const predefinedNames = new Set(predefined.map((header) => header.key));
  const counts = new Map<string, { count: number; first: ParameterDeclaration; operation: OperationInfo }>();
  for (const endpoint of intermediates) {
    for (const { declaration } of endpoint.headers) {
      if (declaration.key.toLowerCase() === 'authorization') {
        continue;
      }
      const entry = counts.get(declaration.key);
      if (entry === undefined) {
        counts.set(declaration.key, {
          count: 1,
          first: declaration,
          operation: endpoint.operation,
        });
      } else {
        entry.count++;
      }
    }
  }
  const detected: ParameterDeclaration[] = [];
  for (const [name, { count, first, operation }] of counts) {
    if (predefinedNames.has(name)) {
      continue;
    }
    if (
      count >= intermediates.length * GLOBAL_HEADER_THRESHOLD &&
      first.literal === undefined &&
      first.schema !== undefined &&
      isRefNode(first.schema.node)
    ) {
      const { schema: _schema, ...rest } = first;
      detected.push({
        ...rest,
        required: true,
        origin: `Fern makes it a global header because ${count === intermediates.length ? 'every operation declares it' : 'at least 75% of operations declare it'}; its schema is a $ref, and Fern's example check cannot resolve schema references of global headers, so it treats the header as required`,
      });
      continue;
    }
    if (count === intermediates.length) {
      detected.push({
        ...first,
        origin: `Fern makes it a global header because every operation declares it, and takes its definition from ${endpointId(operation)}, where it is ${first.required ? 'required' : 'optional'}`,
      });
    } else if (count >= intermediates.length * GLOBAL_HEADER_THRESHOLD) {
      detected.push({
        ...first,
        required: false,
        origin: 'Fern makes it an optional global header because at least 75% of operations declare it',
      });
    }
  }
  const globalHeaders = [...predefined, ...security.globalHeaders, ...detected];
  const globalNames = new Set(globalHeaders.map((header) => header.key));

  const conflictSignatures = new Map<string, Set<string>>();
  const errorsByEndpoint = intermediates.map((endpoint) => rawErrors(ctx, endpoint.operation));
  for (const errors of errorsByEndpoint) {
    for (const error of errors) {
      const signatures = conflictSignatures.get(error.conflictKey) ?? new Set();
      signatures.add(error.signature);
      conflictSignatures.set(error.conflictKey, signatures);
    }
  }

  return intermediates.map((endpoint, index) => {
    const errors = new Map<string, ErrorModel>();
    for (const error of errorsByEndpoint[index]!) {
      if (errors.has(error.name)) {
        continue;
      }
      errors.set(error.name, {
        name: error.name,
        statusCode: error.statusCode,
        schema: error.schema,
        unknown: (conflictSignatures.get(error.conflictKey)?.size ?? 0) > 1 || isUnknownSchema(ctx, error.schema),
      });
    }
    const endpointHeaders = endpoint.headers
      .map(({ declaration }) => declaration)
      .filter((declaration) => !globalNames.has(declaration.key) && declaration.key !== security.authHeaderName);
    const detectedNames = new Set(detected.map((header) => header.key));
    const headers = globalHeaders.map((header) => {
      if (!detectedNames.has(header.key)) {
        return header;
      }
      // The origin only matters when the global declaration differs from the operation's own.
      const own = endpoint.headers.find(({ declaration }) => declaration.key === header.key);
      if (own !== undefined && own.declaration.required === header.required) {
        const { origin: _origin, ...rest } = header;
        return rest;
      }
      return header;
    });
    const wrapper = facts === undefined ? undefined : buildRequestWrapper(ctx, endpoint.operation, facts);
    return {
      operation: endpoint.operation,
      parameters: {
        header: [...headers, ...endpointHeaders],
        'path parameter': resolvePathParameterKeys(ctx, endpoint, wrapper),
        'query parameter': endpoint.query,
      },
      dropped: endpoint.dropped,
      request: endpoint.request,
      droppedReadOnlyKeys: wrapper?.droppedReadOnlyKeys ?? new Set(),
      response: responseModel(ctx, endpoint.operation),
      errors,
    };
  });
}
