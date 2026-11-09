import { camelCase } from 'lodash-es';
import {
  getJsonMediaType,
  getMediaType,
  getOperations,
  operationLabel,
  schemaOfMediaType,
  type OperationInfo,
} from './document.ts';
import { isPlainObject, isRefNode, resolveChild, resolveNode } from './resolve.ts';
import { isObjectSchema, unwrapSchema } from './schema.ts';
import { getGeneratedTypeName, requestNameOverride, stringExtension, typeNameForSchemaKey } from './type-names.ts';
import type { AnyNode, Located, Location, UserContext } from './types.ts';

/**
 * Models the names Fern's OpenAPI importer declares in the generated Fern definition: types
 * (from `components.schemas` and from inline schemas with `x-fern-type-name`), request wrappers
 * of endpoints, and errors (one per 4xx/5xx status code).
 */

type Ctx = Pick<UserContext, 'resolve'>;

export const SCHEMA_REF_PREFIX = '#/components/schemas/';

/** Fern's error names by status code (`convertToHttpError.ts`). */
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

/** Component keys Fern renames to `<key>Body` so they do not clash with its error names. */
export const ERROR_NAMES = new Set<string>([
  ...Object.values(ERROR_NAMES_BY_STATUS_CODE),
  ...Object.values(WILDCARD_ERROR_NAMES),
]);

export type NameSource =
  /** `x-fern-type-name` on a component or inline schema. */
  | 'x-fern-type-name'
  /** Generated from the `components.schemas` key. */
  | 'schema-key'
  /** A component key Fern suffixes with `Body` because it equals one of its error names. */
  | 'error-name-key'
  | 'x-fern-request-name'
  | 'x-request-name'
  /** `x-fern-type-name` on an inline request body schema. */
  | 'request-body-type-name'
  /** A `components.schemas` body schema that Fern inlines into the request. */
  | 'request-body-schema'
  /** Generated from the SDK method name, operationId or method and path. */
  | 'generated'
  /** One of the two requests of an operation with an `x-fern-streaming` stream-condition. */
  | 'stream-condition'
  | 'error';

export interface Declaration {
  name: string;
  kind: 'type' | 'request' | 'error';
  source: NameSource;
  /** The directory of the Fern definition file the name is declared in. */
  scope: string;
  /**
   * The Fern definition file (without extension) a type is declared in, when known. Fern keeps
   * only the last of several types with the same name in one file.
   */
  file?: string;
  /** Names the declaration for messages, e.g. `the schema components.schemas.Plant`. */
  subject: string;
  /** {@link subject} plus how Fern arrived at the name. */
  description: string;
  /** Where to report problems about this declaration. */
  location: Location;
  /** The `components.schemas` key, for component types. */
  schemaKey?: string;
  /** The raw node of inline types, to recognise repeated identical declarations. */
  node?: AnyNode;
}

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapePointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** The component key a local `$ref` points to, or undefined for other references. */
export function localSchemaKey(ref: string): string | undefined {
  if (!ref.startsWith(SCHEMA_REF_PREFIX)) {
    return undefined;
  }
  const rest = ref.slice(SCHEMA_REF_PREFIX.length);
  if (rest.length === 0 || rest.includes('/')) {
    return undefined;
  }
  return unescapePointerSegment(rest);
}

const REQUEST_BODY_SCHEMA_POINTER =
  /^#\/(?:paths\/[^/]+\/[a-z]+\/requestBody|components\/requestBodies\/[^/]+)\/content\/[^/]+\/schema$/;

/** Whether a pointer is the top-level schema of a request body media type. */
export function isRequestBodySchemaPointer(pointer: string): boolean {
  return REQUEST_BODY_SCHEMA_POINTER.test(pointer);
}

/** Pointers of every local `$ref` to a component schema in the root document, by key. */
function indexSchemaRefs(root: AnyNode): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const seen = new Set<AnyNode>();
  const walk = (node: AnyNode, pointer: string): void => {
    if (typeof node !== 'object' || node === null || seen.has(node)) {
      return;
    }
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((child, index_) => walk(child, `${pointer}/${index_}`));
      return;
    }
    if (typeof node.$ref === 'string') {
      const key = localSchemaKey(node.$ref);
      if (key !== undefined) {
        const pointers = index.get(key) ?? [];
        pointers.push(pointer);
        index.set(key, pointers);
      }
    }
    for (const [key, child] of Object.entries(node)) {
      walk(child, `${pointer}/${escapePointerSegment(key)}`);
    }
  };
  walk(root, '#');
  return index;
}

function camelCasePreservingUnderscores(name: string): string {
  const leading = name.match(/^(_+)/)?.[1] ?? '';
  const trailing = name.match(/(_+)$/)?.[1] ?? '';
  if (leading === '' && trailing === '') {
    return camelCase(name);
  }
  if (leading.length + trailing.length >= name.length) {
    return name;
  }
  const core = name.slice(leading.length, name.length - trailing.length || undefined);
  return `${leading}${camelCase(core)}${trailing}`;
}

function groupNameOf(value: AnyNode): string[] | undefined {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value) && value.every((entry: AnyNode) => typeof entry === 'string')) {
    return value;
  }
  return undefined;
}

const PACKAGE_FILE = '__package__';

/**
 * The Fern definition file (without extension) for an SDK group name, mirroring
 * `convertSdkGroupNameToFile`.
 */
function fileOf(groupName: string[], namespace: string | undefined): string {
  const segments: string[] = [];
  if (namespace !== undefined) {
    segments.push(groupName.length > 0 ? camelCasePreservingUnderscores(namespace) : namespace);
    if (groupName.length === 0) {
      segments.push(PACKAGE_FILE);
    }
  }
  segments.push(...groupName.map(camelCasePreservingUnderscores));
  return segments.length === 0 ? PACKAGE_FILE : segments.join('/');
}

/** The directory of a Fern definition file. Names in the same directory share one namespace. */
function directoryOf(file: string): string {
  const index = file.lastIndexOf('/');
  return index === -1 ? '.' : file.slice(0, index);
}

/** The directory of the Fern definition file for an SDK group name. */
function scopeOf(groupName: string[], namespace: string | undefined): string {
  return directoryOf(fileOf(groupName, namespace));
}

/**
 * The file Fern puts an endpoint in, mirroring `getEndpointLocation`: the SDK group of
 * `x-fern-sdk-method-name`, else the first tag, else the root package.
 */
function endpointFileOf(operation: AnyNode): string {
  const sdkMethod = sdkMethodOf(operation);
  if (sdkMethod !== undefined) {
    return fileOf(sdkMethod.groupName, undefined);
  }
  const tag = Array.isArray(operation.tags) ? operation.tags[0] : undefined;
  if (typeof tag !== 'string') {
    return PACKAGE_FILE;
  }
  if (typeof operation.operationId === 'string' && camelCase(operation.operationId) === camelCase(tag)) {
    return PACKAGE_FILE;
  }
  return camelCase(tag);
}

interface ComponentInfo {
  key: string;
  /** The component after following external `$ref`s. */
  resolved: Located | undefined;
  entryLocation: Location;
  ignored: boolean;
  scope: string;
  file: string;
  name: string;
  source: NameSource;
  nameLocation: Location;
}

function componentInfos(ctx: Ctx, root: Located): ComponentInfo[] {
  const components = resolveChild(ctx, root, 'components');
  const schemas = components === undefined ? undefined : resolveChild(ctx, components, 'schemas');
  if (schemas === undefined || !isPlainObject(schemas.node)) {
    return [];
  }
  return Object.keys(schemas.node).map((key) => {
    const raw = schemas.node[key];
    const entryLocation = schemas.location.child(key);
    const isLocalAlias = isRefNode(raw) && raw.$ref.startsWith('#');
    const resolved = isLocalAlias ? undefined : resolveNode(ctx, raw, entryLocation);
    const schema = resolved?.node;
    const ignored = isPlainObject(schema) && schema['x-fern-ignore'] === true;
    const groupName =
      groupNameOf(isPlainObject(schema) ? schema['x-fern-sdk-group-name'] : undefined) ??
      groupNameOf(isPlainObject(schema) && Array.isArray(schema['x-tags']) ? schema['x-tags'][0] : undefined) ??
      [];
    const file = fileOf(groupName, stringExtension(schema, 'x-fern-sdk-namespace'));
    const scope = directoryOf(file);
    const typeName = stringExtension(schema, 'x-fern-type-name');
    let name: string;
    let source: NameSource;
    let nameLocation: Location;
    if (!isLocalAlias && ERROR_NAMES.has(key)) {
      name = `${key}Body`;
      source = 'error-name-key';
      nameLocation = entryLocation.key();
    } else if (typeName !== undefined && resolved !== undefined) {
      name = typeName;
      source = 'x-fern-type-name';
      nameLocation = resolved.location.child('x-fern-type-name');
    } else {
      name = typeNameForSchemaKey(key);
      source = 'schema-key';
      nameLocation = entryLocation.key();
    }
    return {
      key,
      resolved,
      entryLocation,
      ignored,
      scope,
      file,
      name,
      source,
      nameLocation,
    };
  });
}

function describe(subject: string, detail: string | undefined) {
  return {
    subject,
    description: detail === undefined ? subject : `${subject} (${detail})`,
  };
}

function describeComponent(component: ComponentInfo) {
  const subject = `the schema components.schemas.${component.key}`;
  switch (component.source) {
    case 'x-fern-type-name':
      return describe(subject, 'named by its x-fern-type-name');
    case 'error-name-key':
      return describe(subject, `renamed with a "Body" suffix because "${component.key}" is a Fern error name`);
    default:
      return describe(subject, undefined);
  }
}

function sdkMethodOf(operation: AnyNode): { methodName: string; groupName: string[] } | undefined {
  const methodName = stringExtension(operation, 'x-fern-sdk-method-name');
  if (methodName === undefined) {
    return undefined;
  }
  return {
    methodName,
    groupName: groupNameOf(operation['x-fern-sdk-group-name']) ?? [],
  };
}

interface GeneratedName {
  breadcrumbs: string[];
  /** What the name was generated from, for messages. */
  from: string;
  location: Location;
}

/** Mirrors `getBaseBreadcrumbs` with `shouldUseIdiomaticRequestNames` (Fern's default). */
function baseBreadcrumbs(operation: OperationInfo): GeneratedName {
  const sdkMethod = sdkMethodOf(operation.node);
  if (sdkMethod !== undefined) {
    const breadcrumbs = [sdkMethod.methodName];
    const lastGroup = sdkMethod.groupName[sdkMethod.groupName.length - 1];
    if (lastGroup !== undefined) {
      breadcrumbs.push(lastGroup);
    }
    return {
      breadcrumbs,
      from: 'x-fern-sdk-method-name and x-fern-sdk-group-name',
      location: operation.location.child('x-fern-sdk-method-name'),
    };
  }
  if (typeof operation.node.operationId === 'string') {
    return {
      breadcrumbs: [operation.node.operationId],
      from: `operationId "${operation.node.operationId}"`,
      location: operation.location.child('operationId'),
    };
  }
  return {
    breadcrumbs: [camelCase(`${operation.method}_${operation.path.split('/').join('_')}`)],
    from: 'the method and path',
    location: operation.location.key(),
  };
}

function globalHeaderNames(root: AnyNode): Set<string> {
  const names = new Set<string>();
  const headers = isPlainObject(root) ? root['x-fern-global-headers'] : undefined;
  if (Array.isArray(headers)) {
    for (const header of headers) {
      if (isPlainObject(header) && typeof header.header === 'string') {
        names.add(header.header.toLowerCase());
      }
    }
  }
  return names;
}

function isSkippedOperation(operation: AnyNode): boolean {
  return operation['x-fern-ignore'] === true || operation['x-fern-async-config'] !== undefined;
}

/** `x-fern-streaming` when it has a `stream-condition`: Fern splits such operations in two. */
function streamConditionOf(operation: AnyNode): Record<string, AnyNode> | undefined {
  const streaming = operation['x-fern-streaming'];
  return isPlainObject(streaming) && streaming['stream-condition'] !== undefined ? streaming : undefined;
}

interface RequestBodyMedia {
  requestBody: Located;
  json?: Located;
  multipart?: Located;
}

/** The request body media type Fern converts: JSON (or form-urlencoded), else multipart. */
function requestBodyMediaOf(ctx: Ctx, operation: OperationInfo): RequestBodyMedia | undefined {
  if (operation.method === 'get') {
    return undefined;
  }
  const requestBody = resolveChild(ctx, { node: operation.node, location: operation.location }, 'requestBody');
  if (requestBody === undefined) {
    return undefined;
  }
  const json =
    getJsonMediaType(ctx, requestBody) ?? getMediaType(ctx, requestBody, 'application/x-www-form-urlencoded');
  const multipart = json === undefined ? getMediaType(ctx, requestBody, 'multipart/form-data') : undefined;
  return { requestBody, json, multipart };
}

/**
 * The key Fern's bundler gives a schema `$ref`'d from another file (`./schemas.yaml#/Chat` or
 * `./api.yaml#/components/schemas/Chat`), or undefined for local and whole-file references.
 */
function externalSchemaKey(schema: Located, rootRef: string): string | undefined {
  if (!isRefNode(schema.node)) {
    return undefined;
  }
  const ref = schema.node.$ref;
  const hash = ref.indexOf('#');
  if (hash === -1 || (hash === 0 && schema.location.source.absoluteRef === rootRef)) {
    return undefined;
  }
  const match = /^\/(?:components\/schemas\/)?([^/]+)$/.exec(ref.slice(hash + 1));
  return match === null ? undefined : unescapePointerSegment(match[1]!);
}

/** The component key of a schema that is a local `$ref` to `components.schemas`. */
function componentKeyOf(schema: Located | undefined): string | undefined {
  return isRefNode(schema?.node) ? localSchemaKey(schema.node.$ref) : undefined;
}

export interface DeclarationIndex {
  declarations: Declaration[];
  /** Scope of each operation, keyed by the operation's absolute pointer. */
  operationScopes: Map<string, string>;
  /** Components by key. */
  components: Map<string, { scope: string; ignored: boolean }>;
  /** Component keys Fern inlines into a request wrapper instead of declaring a type. */
  inlinedComponents: Set<string>;
}

/**
 * Collects the names Fern declares for the document. `inlineTypes` are inline schemas carrying
 * `x-fern-type-name`, gathered by a `Schema` visitor.
 */
export function collectDeclarations(ctx: Ctx, root: Located, inlineTypes: Located[]): DeclarationIndex {
  const components = componentInfos(ctx, root);
  const componentsByKey = new Map(components.map((info) => [info.key, info]));
  const refIndex = indexSchemaRefs(root.node);
  const componentTypeNames = new Set(components.map((info) => typeNameForSchemaKey(info.key)));
  const globalHeaders = globalHeaderNames(root.node);
  const excludedComponents = new Set<string>();
  const requests: Declaration[] = [];
  const rootRef = root.location.source.absoluteRef;
  /** External schemas of stream-condition request bodies, which Fern still declares as types. */
  const bundledTypes: Declaration[] = [];
  const externalTypes = new Set<string>();
  const errors = new Map<string, Declaration>();
  const operationScopes = new Map<string, string>();
  const operationFiles = new Map<string, { scope: string; file: string }>();

  const operations = getOperations(ctx, root).filter((operation) => !isSkippedOperation(operation.node));

  // Fern inlines a component used as a JSON request body into the request, unless the component
  // is also referenced elsewhere or is the request body of more than one operation. Operations
  // with a stream-condition copy the body schema instead of referencing it.
  const requestBodyUses = new Map<string, number>();
  for (const operation of operations) {
    if (streamConditionOf(operation.node) !== undefined) {
      continue;
    }
    const media = requestBodyMediaOf(ctx, operation);
    const key = componentKeyOf(media?.json === undefined ? undefined : schemaOfMediaType(media.json));
    if (key !== undefined) {
      requestBodyUses.set(key, (requestBodyUses.get(key) ?? 0) + 1);
    }
  }
  const isInlinedRequestBody = (key: string): boolean =>
    requestBodyUses.get(key) === 1 && (refIndex.get(key) ?? []).every(isRequestBodySchemaPointer);

  for (const operation of operations) {
    const sdkMethod = sdkMethodOf(operation.node);
    const scope = sdkMethod === undefined ? '.' : scopeOf(sdkMethod.groupName, undefined);
    operationScopes.set(operation.location.absolutePointer, scope);
    operationFiles.set(operation.location.absolutePointer, {
      scope,
      file: endpointFileOf(operation.node),
    });
    const label = operationLabel(operation);
    const override = requestNameOverride(operation.node);

    const parameters = operation.parameters.filter(
      (parameter) =>
        parameter.node['x-fern-ignore'] !== true &&
        (parameter.in === 'query' ||
          parameter.in === 'path' ||
          (parameter.in === 'header' && !globalHeaders.has(parameter.name.toLowerCase()))),
    );
    const hasQuery = parameters.some((parameter) => parameter.in === 'query');
    const hasParameters = parameters.length > 0;

    const base = baseBreadcrumbs(operation);
    const requestTypeName = getGeneratedTypeName([...base.breadcrumbs, 'Request']);
    const generatedRequestName = componentTypeNames.has(requestTypeName)
      ? getGeneratedTypeName([...base.breadcrumbs, 'Body'])
      : requestTypeName;

    const addRequest = (name: string, source: NameSource, location: Location, detail: string): void => {
      requests.push({
        name,
        kind: 'request',
        source,
        scope,
        ...describe(`the request of ${label}`, detail),
        location,
      });
    };
    const addRequestWithOverride = (fallback: () => void): void => {
      if (override !== undefined) {
        addRequest(
          override.name,
          override.extension as NameSource,
          operation.location.child(override.extension),
          `named by its ${override.extension}`,
        );
      } else {
        fallback();
      }
    };
    const addGenerated = (name: string): void =>
      addRequestWithOverride(() => addRequest(name, 'generated', base.location, `name generated from ${base.from}`));

    const media = requestBodyMediaOf(ctx, operation);
    const requestBody = media?.requestBody;
    const json = media?.json;
    const multipart = media?.multipart;
    const streamCondition = streamConditionOf(operation.node);

    if (streamCondition !== undefined) {
      const schema = json === undefined ? undefined : schemaOfMediaType(json);
      if (schema !== undefined && isObjectSchema(ctx, schema)) {
        const resolved = resolveNode(ctx, schema.node, schema.location);
        const typeName = stringExtension(resolved?.node, 'x-fern-type-name');
        const streamRequestName = stringExtension(streamCondition, 'stream-request-name');
        const addStreamRequest = (streaming: boolean, name: string, location: Location, how: string): void => {
          requests.push({
            name,
            kind: 'request',
            source: 'stream-condition',
            scope,
            ...describe(`the ${streaming ? 'streaming' : 'non-streaming'} request of ${label}`, how),
            location,
          });
        };
        const addNamed = (streaming: boolean, breadcrumbs: string[]): void => {
          if (override !== undefined) {
            addStreamRequest(
              streaming,
              override.name,
              operation.location.child(override.extension),
              `named by its ${override.extension}`,
            );
          } else if (typeName !== undefined) {
            addStreamRequest(
              streaming,
              typeName,
              operation.location.child('x-fern-streaming').key(),
              'named by the x-fern-type-name of its request body schema',
            );
          } else {
            addStreamRequest(
              streaming,
              getGeneratedTypeName(breadcrumbs),
              base.location,
              `name generated from ${base.from}`,
            );
          }
        };
        const external = externalSchemaKey(schema, rootRef);
        if (
          external !== undefined &&
          typeName === undefined &&
          !componentsByKey.has(external) &&
          !externalTypes.has(external)
        ) {
          externalTypes.add(external);
          bundledTypes.push({
            name: typeNameForSchemaKey(external),
            kind: 'type',
            source: 'schema-key',
            scope: '.',
            file: PACKAGE_FILE,
            ...describe(
              `the schema ${describeLocation(resolved?.location ?? schema.location, rootRef)}`,
              'which Fern copies into components.schemas when it bundles the document',
            ),
            location: resolved?.location ?? schema.location,
          });
        }
        addNamed(false, [...base.breadcrumbs, 'Request']);
        if (streamRequestName !== undefined) {
          addStreamRequest(
            true,
            streamRequestName,
            operation.location.child(['x-fern-streaming', 'stream-request-name']),
            'named by its x-fern-streaming stream-request-name',
          );
        } else if (isRefNode(schema.node) && typeName !== undefined) {
          addStreamRequest(
            true,
            `${typeName}Streaming`,
            operation.location.child('x-fern-streaming').key(),
            'named after the x-fern-type-name of its request body schema',
          );
        } else {
          addNamed(true, [...base.breadcrumbs, 'stream', 'Request']);
        }
      }
    } else if (json !== undefined) {
      const schema = schemaOfMediaType(json);
      const componentKey = componentKeyOf(schema);
      const component = componentKey === undefined ? undefined : componentsByKey.get(componentKey);
      if (component !== undefined && schema !== undefined) {
        if (isObjectSchema(ctx, schema) && isInlinedRequestBody(component.key)) {
          excludedComponents.add(component.key);
          addRequestWithOverride(() =>
            addRequest(
              component.name,
              'request-body-schema',
              schema.location,
              `named after its request body schema components.schemas.${component.key}, which Fern inlines into the request`,
            ),
          );
        } else if (hasParameters) {
          addGenerated(generatedRequestName);
        }
      } else if (schema !== undefined && isObjectSchema(ctx, schema)) {
        const resolved = unwrapSchema(ctx, schema);
        const typeName = stringExtension(resolved?.node, 'x-fern-type-name');
        addRequestWithOverride(() => {
          if (typeName !== undefined && resolved !== undefined) {
            addRequest(
              typeName,
              'request-body-type-name',
              resolved.location.child('x-fern-type-name'),
              'named by the x-fern-type-name of its request body schema',
            );
          } else {
            addRequest(requestTypeName, 'generated', base.location, `name generated from ${base.from}`);
          }
        });
      } else if (hasParameters) {
        addGenerated(generatedRequestName);
      }
    } else if (multipart !== undefined) {
      const schema = schemaOfMediaType(multipart);
      const componentKey = componentKeyOf(schema);
      if (
        componentKey !== undefined &&
        schema !== undefined &&
        componentsByKey.has(componentKey) &&
        (refIndex.get(componentKey) ?? []).length === 1
      ) {
        excludedComponents.add(componentKey);
        addRequestWithOverride(() =>
          addRequest(
            componentKey,
            'request-body-schema',
            schema.location,
            `named after its multipart request body schema components.schemas.${componentKey}, which Fern inlines into the request`,
          ),
        );
      } else {
        addGenerated(generatedRequestName);
      }
    } else if (requestBody !== undefined) {
      if (hasQuery) {
        addGenerated(generatedRequestName);
      }
    } else if (hasParameters) {
      addGenerated(generatedRequestName);
    }

    const responses = resolveChild(ctx, { node: operation.node, location: operation.location }, 'responses');
    if (responses !== undefined && isPlainObject(responses.node)) {
      for (const statusCode of Object.keys(responses.node)) {
        const wildcard = WILDCARD_ERROR_NAMES[statusCode.toUpperCase()];
        const parsed = parseInt(statusCode, 10);
        const name = wildcard ?? (parsed >= 400 && parsed <= 600 ? ERROR_NAMES_BY_STATUS_CODE[parsed] : undefined);
        if (name === undefined || errors.has(name)) {
          continue;
        }
        errors.set(name, {
          name,
          kind: 'error',
          source: 'error',
          scope: '.',
          ...describe(`the error Fern declares for "${statusCode}" responses`, undefined),
          location: responses.location.child(statusCode).key(),
        });
      }
    }
  }

  const declarations: Declaration[] = [];
  for (const component of components) {
    if (component.ignored || excludedComponents.has(component.key)) {
      continue;
    }
    declarations.push({
      name: component.name,
      kind: 'type',
      source: component.source,
      scope: component.scope,
      file: component.file,
      ...describeComponent(component),
      location: component.nameLocation,
      schemaKey: component.key,
    });
  }

  declarations.push(...bundledTypes);
  const componentTargets = new Set(
    components.flatMap((info) => (info.resolved === undefined ? [] : [info.resolved.location.absolutePointer])),
  );
  for (const inline of inlineTypes) {
    const name = stringExtension(inline.node, 'x-fern-type-name');
    if (name === undefined || componentTargets.has(inline.location.absolutePointer)) {
      continue;
    }
    let scope = '.';
    let file: string | undefined;
    const pointer = inline.location.pointer;
    if (inline.location.source.absoluteRef === rootRef) {
      const componentMatch = /^#\/components\/schemas\/([^/]+)\//.exec(pointer);
      if (componentMatch !== null) {
        const component = componentsByKey.get(unescapePointerSegment(componentMatch[1]!));
        if (component?.ignored === true) {
          continue;
        }
        scope = component?.scope ?? '.';
        file = component?.file;
      } else {
        for (const [operationPointer, operation] of operationFiles) {
          if (inline.location.absolutePointer.startsWith(`${operationPointer}/`)) {
            scope = operation.scope;
            file = operation.file;
            break;
          }
        }
      }
    }
    declarations.push({
      name,
      kind: 'type',
      source: 'x-fern-type-name',
      scope,
      file,
      ...describe(
        `the inline schema at ${describeLocation(inline.location, rootRef)}`,
        'named by its x-fern-type-name',
      ),
      location: inline.location.child('x-fern-type-name'),
      node: inline.node,
    });
  }

  declarations.push(...requests, ...errors.values());
  return {
    declarations,
    operationScopes,
    components: new Map(components.map((info) => [info.key, { scope: info.scope, ignored: info.ignored }])),
    inlinedComponents: excludedComponents,
  };
}

/**
 * Whether an inline schema carrying `x-fern-type-name` becomes a named Fern type: objects, string
 * enums and unions do; primitives, arrays and the object schema of a request body (which becomes
 * the request wrapper) do not.
 */
export function isInlineTypeDeclaration(ctx: Ctx, located: Located, rootRef: string): boolean {
  const schema = located.node;
  if (!isPlainObject(schema) || typeof schema['x-fern-type-name'] !== 'string') {
    return false;
  }
  if (
    located.location.source.absoluteRef === rootRef &&
    /^#\/components\/schemas\/[^/]+$/.test(located.location.pointer)
  ) {
    return false;
  }
  const isObject = isObjectSchema(ctx, located);
  if (isObject && isRequestBodySchemaPointer(located.location.pointer)) {
    return false;
  }
  if (isObject || Array.isArray(schema.enum)) {
    return true;
  }
  const union = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
  if (union === undefined) {
    return false;
  }
  const unwrapped = unwrapSchema(ctx, located);
  return unwrapped?.location.absolutePointer === located.location.absolutePointer;
}

/** A location as text relative to the root document, for messages. */
export function describeLocation(location: Location, rootRef: string): string {
  if (location.source.absoluteRef === rootRef) {
    return location.pointer;
  }
  const file = location.source.absoluteRef.split(/[\\/]/).pop() ?? '';
  return `${file}${location.pointer}`;
}
