/**
 * Validates an OAuth client-credentials configuration against the document.
 *
 * Fern configures OAuth for OpenAPI workspaces outside the document (the `auth-schemes` of the
 * generator configuration), so this rule takes the same configuration as options:
 *
 * ```yaml
 * rules:
 *   generators/valid-oauth:
 *     severity: error
 *     getToken:
 *       endpoint: POST /token
 *       requestProperties: { clientId: $request.client_id, clientSecret: $request.client_secret, scopes: $request.scope }
 *       responseProperties: { accessToken: $response.access_token, expiresIn: $response.expires_in, refreshToken: $response.refresh_token }
 *     refreshToken:
 *       endpoint: POST /token/refresh
 *       requestProperties: { refreshToken: $request.refresh_token }
 *       responseProperties: { accessToken: $response.access_token, expiresIn: $response.expires_in, refreshToken: $response.refresh_token }
 * ```
 *
 * Endpoints are `METHOD /path` with an uppercase method, optionally prefixed with a `namespace::`
 * (which this rule ignores); Fern does not resolve operationIds. Unset request and response properties fall
 * back to Fern's defaults (`$request.client_id`, `$request.client_secret`,
 * `$response.access_token`, `$request.refresh_token`). Without options the rule does nothing.
 */
import { endpointId, getOperations, rootOf, type OperationInfo } from '../utils/document.ts';
import {
  describeMissingResponse,
  getFernResponse,
  isIgnored,
  lookupRequestProperty,
  lookupResponseProperty,
  parseSelector,
  primitiveIn,
  REQUEST_PREFIX,
  RESPONSE_PREFIX,
  type SchemaPredicate,
} from '../utils/property-path.ts';
import { isPlainObject } from '../utils/resolve.ts';
import type { AnyNode, Located, Location, RuleDefinition, UserContext } from '../utils/types.ts';

const DEFAULT_CLIENT_ID = `${REQUEST_PREFIX}client_id`;
const DEFAULT_CLIENT_SECRET = `${REQUEST_PREFIX}client_secret`;
const DEFAULT_ACCESS_TOKEN = `${RESPONSE_PREFIX}access_token`;
const DEFAULT_REFRESH_TOKEN = `${REQUEST_PREFIX}refresh_token`;

const STRING = primitiveIn('STRING');
const INTEGER = primitiveIn('INTEGER', 'LONG');

interface PropertyCheck {
  /** Option key, e.g. `clientId`. */
  option: string;
  /** Fern's property id, e.g. `client-id`. */
  id: string;
  side: 'request' | 'response';
  predicate: SchemaPredicate;
  expected: string;
  /** Fern's default selector; when set, an unset option is checked against it. */
  fallback?: string;
}

const TOKEN_REQUEST: PropertyCheck[] = [
  {
    option: 'clientId',
    id: 'client-id',
    side: 'request',
    predicate: STRING,
    expected: 'a string',
    fallback: DEFAULT_CLIENT_ID,
  },
  {
    option: 'clientSecret',
    id: 'client-secret',
    side: 'request',
    predicate: STRING,
    expected: 'a string',
    fallback: DEFAULT_CLIENT_SECRET,
  },
  {
    option: 'scopes',
    id: 'scopes',
    side: 'request',
    predicate: STRING,
    expected: 'a string',
  },
];

const REFRESH_REQUEST: PropertyCheck[] = [
  {
    option: 'refreshToken',
    id: 'refresh-token',
    side: 'request',
    predicate: STRING,
    expected: 'a string',
    fallback: DEFAULT_REFRESH_TOKEN,
  },
];

const TOKEN_RESPONSE: PropertyCheck[] = [
  {
    option: 'accessToken',
    id: 'access-token',
    side: 'response',
    predicate: STRING,
    expected: 'a string',
    fallback: DEFAULT_ACCESS_TOKEN,
  },
  {
    option: 'expiresIn',
    id: 'expires-in',
    side: 'response',
    predicate: INTEGER,
    expected: 'an integer',
  },
  {
    option: 'refreshToken',
    id: 'refresh-token',
    side: 'response',
    predicate: STRING,
    expected: 'a string',
  },
];

interface EndpointOptions {
  endpoint?: unknown;
  requestProperties?: Record<string, unknown>;
  responseProperties?: Record<string, unknown>;
}

/** Fern's endpoint reference syntax for OpenAPI workspaces: `[namespace::]METHOD /path`. */
const ENDPOINT_REFERENCE = /^(?:(\w+)::)?(GET|POST|PUT|DELETE|PATCH|HEAD)\s(\/\S*)$/;

type EndpointLookup = { kind: 'found'; operation: OperationInfo } | { kind: 'malformed' } | { kind: 'missing' };

function findOperation(operations: OperationInfo[], reference: string): EndpointLookup {
  const match = ENDPOINT_REFERENCE.exec(reference);
  if (match === null) {
    return { kind: 'malformed' };
  }
  const method = match[2]!.toLowerCase();
  const path = match[3]!;
  const operation = operations.find((candidate) => candidate.method === method && candidate.path === path);
  return operation === undefined ? { kind: 'missing' } : { kind: 'found', operation };
}

function checkEndpoint(
  ctx: UserContext,
  operation: OperationInfo,
  options: EndpointOptions,
  optionName: string,
  requestChecks: PropertyCheck[],
): void {
  const id = endpointId(operation);
  const prefix = `OAuth configuration for endpoint ${id}`;
  const requestLocation: Location =
    operation.node.requestBody !== undefined ? operation.location.child('requestBody') : operation.location;
  const response = getFernResponse(ctx, operation);

  const check = (spec: PropertyCheck, properties: unknown): void => {
    const configured = isPlainObject(properties) ? properties[spec.option] : undefined;
    const optionPath = `${optionName}.${spec.side}Properties.${spec.option}`;
    const example = spec.id.replace('-', '_');
    if (configured != null && typeof configured !== 'string') {
      ctx.report({
        message: `The ${optionPath} option of generators/valid-oauth must be a string selector such as '${spec.side === 'request' ? REQUEST_PREFIX : RESPONSE_PREFIX}${example}'.`,
        location: operation.location,
      });
      return;
    }
    const selector = configured ?? spec.fallback;
    if (selector === undefined) {
      return;
    }
    const usesDefault = configured == null;
    const sidePrefix = spec.side === 'request' ? REQUEST_PREFIX : RESPONSE_PREFIX;
    const sideName = sidePrefix.slice(0, -1);
    const path = parseSelector(selector, sidePrefix);
    const fallbackLocation =
      spec.side === 'request'
        ? requestLocation
        : response.kind === 'json'
          ? (response.schema?.location ?? response.response.location)
          : operation.location.child('responses');
    if (path === undefined) {
      ctx.report({
        message: `${prefix} must define a dot-delimited '${spec.id}' property starting with ${sideName} (e.g. ${sideName}.${example}).`,
        location: operation.location,
      });
      return;
    }
    if (spec.side === 'request' && path.length > 1) {
      ctx.report({
        message: `${prefix} cannot reference nested $request properties like '${selector}'; expected a top-level property such as '${REQUEST_PREFIX}${example}' instead.`,
        location: requestLocation,
      });
      return;
    }
    let lookup: { valid: boolean; match?: Located };
    if (spec.side === 'request') {
      lookup = lookupRequestProperty(ctx, operation, path, spec.predicate);
    } else if (response.kind === 'json') {
      lookup = lookupResponseProperty(ctx, response.schema, path, spec.predicate);
    } else {
      return;
    }
    if (lookup.valid) {
      return;
    }
    const where =
      spec.side === 'request'
        ? 'an `in: query` parameter or request body property'
        : 'a property of the JSON success response';
    const location = lookup.match?.location ?? fallbackLocation;
    if (usesDefault) {
      ctx.report({
        message: `${prefix} is missing a valid ${spec.id}, such as '${selector}'. Add ${where} named ${path.join('.')} whose type is ${spec.expected}, or point the ${optionPath} option at an existing one.`,
        location,
      });
      return;
    }
    ctx.report({
      message: `${prefix} specifies '${spec.id}' ${selector}, which is not a valid '${spec.id}' type. It must point to ${where} whose type is ${spec.expected}.`,
      location,
    });
  };

  for (const spec of requestChecks) {
    check(spec, options.requestProperties);
  }
  if (response.kind === 'none') {
    ctx.report({
      message: `${prefix} must define a response type: ${describeMissingResponse(response.reason)}.`,
      location: response.response?.location ?? operation.location,
    });
    return;
  }
  for (const spec of TOKEN_RESPONSE) {
    check(spec, options.responseProperties);
  }
}

export const validOauth: RuleDefinition = {
  name: 'valid-oauth',
  sourceRules: ['fern-definition/valid-oauth'],
  severity: 'error',
  description:
    'The OAuth client-credentials token and refresh endpoints configured in the rule options must exist and expose the configured request and response properties.',
  rule: (options: Record<string, AnyNode> = {}) => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        const getToken = options.getToken;
        const refreshToken = options.refreshToken;
        if (getToken == null && refreshToken == null) {
          return;
        }
        const document = rootOf(root, ctx);
        const pathsLocation =
          isPlainObject(root) && root.paths !== undefined ? ctx.location.child('paths') : ctx.location;
        const operations = getOperations(ctx, document).filter(
          (operation) => !isIgnored(operation.node) && !isIgnored(operation.pathItem.node),
        );

        const resolve = (optionName: string, value: AnyNode): OperationInfo | undefined => {
          if (!isPlainObject(value) || typeof value.endpoint !== 'string') {
            ctx.report({
              message: `The ${optionName}.endpoint option of generators/valid-oauth must be an endpoint such as "POST /token".`,
              location: pathsLocation,
            });
            return undefined;
          }
          const lookup = findOperation(operations, value.endpoint);
          if (lookup.kind === 'found') {
            return lookup.operation;
          }
          ctx.report({
            message:
              lookup.kind === 'malformed'
                ? `Failed to resolve endpoint ${value.endpoint}: Fern resolves OAuth endpoints written as "METHOD /path", with an uppercase method and the path as written under paths (operationIds are not resolved).`
                : `Failed to resolve endpoint ${value.endpoint}: the document has no such operation (operations with x-fern-ignore do not count).`,
            location: pathsLocation,
          });
          return undefined;
        };

        if (getToken == null) {
          ctx.report({
            message:
              'OAuth client-credentials flow requires a `get-token` endpoint: set the getToken.endpoint option of generators/valid-oauth.',
            location: pathsLocation,
          });
        } else {
          const operation = resolve('getToken', getToken);
          if (operation !== undefined) {
            checkEndpoint(ctx, operation, getToken, 'getToken', TOKEN_REQUEST);
          }
        }
        if (refreshToken != null) {
          const operation = resolve('refreshToken', refreshToken);
          if (operation !== undefined) {
            checkEndpoint(ctx, operation, refreshToken, 'refreshToken', REFRESH_REQUEST);
          }
        }
      },
    },
  }),
};
