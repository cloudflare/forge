/**
 * OpenAPI Resolver
 *
 * Resolves OpenAPI operation IDs to their paths, methods, and type information.
 * This is the foundation for generating SDK and CLI code from schemas.
 */
// Resolver state is populated explicitly from the caller-provided document.
let openapi: OpenAPISpec = { paths: {}, components: { schemas: {} } };

/**
 * Minimal OpenAPI spec types for what we need
 */
export interface OpenAPISpec {
  paths: Record<string, PathItem>;
  components: {
    schemas: Record<string, unknown>;
    parameters?: Record<string, Parameter>;
  };
}

function isOpenAPISpec(value: unknown): value is OpenAPISpec {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  if (typeof rec.paths !== 'object' || rec.paths === null) return false;
  if (typeof rec.components !== 'object' || rec.components === null) return false;
  const components = rec.components as Record<string, unknown>;
  if (typeof components.schemas !== 'object' || components.schemas === null) return false;
  return true;
}

interface PathItem {
  parameters?: Parameter[];
  get?: Operation;
  post?: Operation;
  put?: Operation;
  patch?: Operation;
  delete?: Operation;
}

interface RequestBody {
  /** Reference to a `#/components/requestBodies/...` entry, if applicable. */
  $ref?: string;
  /** Human-readable description of the request body. */
  description?: string;
  content?: Record<string, { schema?: SchemaRef }> & {
    'application/json'?: {
      schema?: SchemaRef;
    };
  };
}

interface Operation {
  operationId?: string;
  description?: string;
  parameters?: Parameter[];
  requestBody?: RequestBody;
  /**
   * Spec-literal status keys: `"200"`, `"201"`, `"204"`, `"4XX"`, `"5XX"`,
   * `"default"`, etc. The resolver doesn't pre-filter; consumers pick the
   * statuses they care about.
   */
  responses?: Record<string, ResponseObject | undefined>;
}

interface ResponseObject {
  $ref?: string;
  description?: string;
  /** Keyed by media type: `"application/json"`, `"application/pdf"`, `"text/plain"`, ... */
  content?: Record<string, { schema?: SchemaRef } | undefined>;
}

interface Parameter {
  $ref?: string;
  name?: string;
  in?: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  schema?: SchemaRef;
  description?: string;
}

interface ResolvedParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  schema?: SchemaRef;
  description?: string;
}

interface SchemaRef {
  $ref?: string;
  type?: string;
  /** OpenAPI `format` annotation (e.g. `binary` for file uploads). */
  format?: string;
  items?: SchemaRef;
  allOf?: SchemaRef[];
  oneOf?: SchemaRef[];
  anyOf?: SchemaRef[];
  properties?: Record<string, SchemaRef | undefined>;
  required?: string[];
  readOnly?: boolean;
  writeOnly?: boolean;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  example?: unknown;
  title?: string;
  /** OpenAPI 3 discriminator metadata for `oneOf` / `anyOf` schemas. */
  discriminator?: {
    propertyName: string;
    mapping?: Record<string, string>;
  };
  'x-cf-api-versions'?: ApiVersionEntry[];
  maxItems?: number;
  'x-sensitive'?: boolean;
}

/**
 * A single version entry from the x-cf-api-versions OpenAPI extension.
 */
export interface ApiVersionEntry {
  /** Component schema name for this version's response shape */
  schema: string;
  /** ISO date — this version is active from this date onward */
  from?: string;
  /** ISO date — this version applies before this date */
  before?: string;
  /** Lifecycle status */
  status: string;
}

/**
 * Resolved operation information
 */
export interface OperationInfo {
  /** API path template, e.g., '/accounts/{account_id}/d1/database' */
  path: string;
  /** HTTP method */
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** Operation description */
  description: string;
  /** Path parameters, e.g., ['account_id', 'database_id'] */
  pathParams: ParameterInfo[];
  /** Query parameters */
  queryParams: ParameterInfo[];
  /** Header parameters (e.g., cf-r2-jurisdiction, CF-WORKER-BODY-PART) */
  headerParams: ParameterInfo[];
  /**
   * Request body properties exposed as CLI-friendly parameters. Nested objects
   * are flattened; direct arrays of objects remain one JSON-valued parameter.
   */
  bodyParams: BodyParamInfo[];
  /** Whether the operation has a request body */
  hasRequestBody: boolean;
  /** Request body content types (e.g., ['application/json', 'multipart/form-data']) */
  requestContentTypes: string[];
  /** Request body schema reference (for type generation) */
  requestBodyRef: string | null;
  /**
   * Names of fields required at the root of the request body's
   * `application/json` schema. Empty array when the body has no top-level
   * `required` list (or the body isn't a JSON object).
   *
   * Distinguishes "this nested object is optional at the parent level" from
   * "this nested object is required at the parent level but its inner
   * fields are required-when-present" — flat-flag CLI consumers need to
   * know which top-level fields a partial body can omit. `bodyParams`
   * surfaces only leaves and carries each leaf's parent-scoped `required`,
   * but doesn't expose root-level required-ness for *branches* (objects
   * the resolver descends into without emitting a leaf for the parent).
   *
   * Example: `wor-change-status-workflow-instance` declares
   * `required: ['status']` at the body root — `status` is required, `from`
   * is optional. The leaves `from.name` (required-within-from) and
   * `status` (required-at-root) both have `required: true` in
   * `bodyParams`, but only `status` appears here.
   */
  requestBodyRequired: string[];
  /**
   * Description of the request body (from `requestBody.description` or, as a
   * fallback, the description of one of the body's content schemas in
   * application/json → application/octet-stream → multipart/form-data order).
   * Useful for replacing generic `--body` help text with operation-specific
   * copy (e.g. "Raw bytes of the value to store" for KV value writes).
   */
  requestBodyDescription?: string;
  /** Resolved `multipart/form-data` field info, if the operation declares one. */
  multipart?: MultipartInfo;
  /** Discriminated `oneOf` body info — discriminator field + variant-specific required fields. */
  bodyDiscriminator?: BodyDiscriminator;
  /**
   * `maxItems` from an array-shaped request body schema. Consumers can use this to split into multiple requests.
   */
  maxItems?: number;
  /**
   * Whether the operation's `application/json` request body is itself a
   * top-level `type: array` (e.g. KV bulk-update sends an array of
   * key-value-pair objects; KV bulk-delete sends an array of strings).
   *
   * `extractBodyProperties` returns `[]` for these — there are no
   * introspectable per-field params to flatten into CLI flags — so
   * `bodyParams.length > 0` is the wrong predicate for "this op has a
   * real wire body". Surfaces are expected to pair this with `bodyParams`
   * when deciding whether to emit a typed body parameter.
   */
  requestBodyIsArray: boolean;
  /**
   * Component `$ref` of an array request body's items, when extractable
   * (e.g. `components['schemas']['workers-kv_request']`). `null` when the
   * body isn't an array, the items are inline, or `items` is itself a
   * `oneOf` / `allOf` envelope without a direct `$ref`. Consumers should
   * fall back to `requestBodyRef` (the array schema's own ref, if any),
   * or otherwise `unknown[]`.
   */
  requestBodyArrayItemRef: string | null;
  /**
   * All declared responses, keyed by spec-literal status code.
   *
   * Keys preserve the OpenAPI form verbatim — `"200"`, `"201"`, `"204"`,
   * `"4XX"`, `"5XX"`, `"default"`, etc. Each entry's `content` is keyed by
   * media type (`"application/json"`, `"application/pdf"`, `"text/plain"`,
   * ...), and each body's `schema` has its top-level `$ref` resolved once
   * so consumers can read `type`, `properties`, `enum`, etc. directly.
   * Nested `$ref`s inside the schema are intentionally left intact — walk
   * them with the exported `resolveDocRef` / `resolveSchemaRef` helpers
   * if you need to descend further.
   *
   * Use this when you need anything beyond the JSON-envelope happy path:
   * binary downloads (`application/pdf`, `application/octet-stream`),
   * streaming (`text/event-stream`), structured error shapes on `4XX`,
   * 201/202/204 success codes, etc.
   */
  responses: Record<string, ResponseInfo>;
  /**
   * Response schema reference for the `200` JSON body, if any. Equivalent
   * to `responses['200']?.content['application/json']?.ref`. Retained as
   * a top-level convenience for the SDK transformer.
   */
  responseRef: string | null;
  /**
   * Whether the `200` JSON body is `type: array`. Equivalent to
   * `responses['200']?.content['application/json']?.isArray` after
   * envelope unwrap. Retained as a top-level convenience.
   */
  responseIsArray: boolean;
  /**
   * The unwrapped `result` field ref when the `200` JSON body is wrapped
   * in the standard `api-response-common` envelope. Retained as a
   * top-level convenience for the SDK transformer; for non-envelope or
   * non-JSON responses, look at `responses` directly.
   */
  resultRef: string | null;
}

/**
 * Resolved-once view of a single response body for one (status, media-type)
 * pair. The `schema` has any top-level `$ref` followed; nested `$ref`s
 * remain raw and can be resolved with `resolveDocRef` / `resolveSchemaRef`.
 */
export interface ResponseBodyInfo {
  /** Resolved schema. May be `undefined` if the spec declared the content type with no schema (rare). */
  schema?: SchemaRef;
  /**
   * Original `components['schemas']['foo']` reference string when the body's
   * top-level schema came from a `$ref`. `null` for inline schemas (including
   * `allOf`/`oneOf` envelopes that have no top-level `$ref`).
   */
  ref: string | null;
  /** True iff the resolved schema is `type: array`. */
  isArray: boolean;
  /** Inner element ref for `type: array` schemas. `null` for non-arrays or arrays with inline items. */
  itemRef: string | null;
}

/**
 * One status-code entry in `OperationInfo.responses`.
 */
export interface ResponseInfo {
  /** Human-readable description from the spec (if any). */
  description?: string;
  /**
   * Bodies keyed by media type. Order is the spec's declaration order.
   * Empty object when the spec declares the status with no `content` (e.g. `204`).
   */
  content: Record<string, ResponseBodyInfo>;
}

/**
 * Describes a single property of a `multipart/form-data` request body.
 *
 * - `name`        — API field name as declared in the OpenAPI schema
 *                   (e.g. 'metadata', 'requireSignedURLs').
 * - `type`        — JSON type ('string' | 'number' | 'boolean' | 'object' | 'array').
 * - `isBinary`    — true when the schema marks the field as `format: binary`
 *                   (i.e. a file upload).
 * - `required`    — whether the schema marks the field as required at the
 *                   multipart level.
 * - `description` — human-readable description from the OpenAPI schema, or
 *                   a synthesised fallback (`"The {name}"`) when the schema
 *                   is undocumented.
 */
export interface MultipartField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  isBinary: boolean;
  required: boolean;
  description: string;
}

/**
 * Result of walking an operation's `multipart/form-data` request body.
 *
 * - `fields`       — all declared properties of the multipart schema.
 * - `payloadField` — the field that carries the primary content. Identified
 *                    as: (a) a field whose raw `$ref` matches the operation's
 *                    `application/octet-stream` schema's `$ref`, (b) the first
 *                    `format: binary` field, or (c) a field literally named
 *                    `"file"`. May be undefined when every field is a
 *                    standalone metadata flag.
 */
export interface MultipartInfo {
  fields: MultipartField[];
  payloadField: string | undefined;
}

/**
 * Discriminated `oneOf` body info.
 *
 * - `field`    — discriminator property name (e.g. `"kind"`, `"type"`).
 * - `variants` — map from discriminator value to the *variant-specific*
 *                required API fields. Fields required across **all** variants
 *                are excluded (those are already surfaced via `bodyParams`
 *                with `required: true`).
 */
export interface BodyDiscriminator {
  field: string;
  variants: Record<string, string[]>;
}

export interface ParameterInfo {
  name: string;
  required: boolean;
  /** Resolved JSON primitive/container type. */
  type: string;
  /** Resolved array item type. */
  itemType?: string;
  /** Enum values from the resolved array item schema. */
  itemEnumValues?: string[];
  /** Whether the parameter schema uses oneOf/anyOf composition. */
  composed?: boolean;
  /** Original local component schema name, when the parameter uses a `$ref`. */
  schemaRef?: string;
  description?: string;
  /** Enum values from the OpenAPI schema, if the parameter is an enum */
  enumValues?: string[];
  /** Default value from the OpenAPI schema (`schema.default`) */
  default?: string | number | boolean;
  sensitive?: boolean;
}

/**
 * A request body property extracted from the OpenAPI schema, with its
 * original API field path for reconstructing the nested body object.
 */
export interface BodyParamInfo extends ParameterInfo {
  /** Path of API field names for nested body reconstruction, e.g. ['origin', 'host'] */
  apiFieldPath: string[];
  /** Flag names this conflicts with (derived from oneOf variant analysis) */
  conflicts?: string[];
  /** Flag names this co-requires (derived from oneOf variant analysis) */
  implies?: string[];
}

// Build reverse lookup: operationId -> OperationInfo
const operationMap = new Map<string, OperationInfo>();

function extractRef(schema: SchemaRef | undefined): string | null {
  if (!schema) return null;
  if (schema.$ref) {
    // Convert "#/components/schemas/foo" to "components['schemas']['foo']"
    const match = schema.$ref.match(/#\/components\/schemas\/(.+)/);
    if (match) {
      return `components['schemas']['${match[1]}']`;
    }
  }
  return null;
}

function extractType(schema: SchemaRef | undefined): string {
  if (!schema) return 'unknown';
  if (schema.$ref) {
    const match = schema.$ref.match(/#\/components\/schemas\/(.+)/);
    if (match?.[1]) return match[1];
  }
  if (schema.type === 'string') return 'string';
  if (schema.type === 'number' || schema.type === 'integer') return 'number';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'array') return 'array';
  if (schema.type === 'object') return 'object';
  if (schema.enum?.length) {
    const enumTypes = new Set(schema.enum.map((value) => typeof value));
    if (enumTypes.size === 1) {
      const [enumType] = enumTypes;
      if (enumType === 'string' || enumType === 'number' || enumType === 'boolean') return enumType;
    }
  }
  if (typeof schema.example === 'string') return 'string';
  if (typeof schema.example === 'number') return 'number';
  if (typeof schema.example === 'boolean') return 'boolean';
  return 'unknown';
}

function componentSchemaName(schema: SchemaRef | undefined): string | undefined {
  const match = schema?.$ref?.match(/^#\/components\/schemas\/(.+)$/);
  return match?.[1]?.replaceAll('~1', '/').replaceAll('~0', '~');
}

function resolveParameterSchema(schema: SchemaRef | undefined, seen = new Set<string>()): SchemaRef | undefined {
  if (!schema) return undefined;
  const name = componentSchemaName(schema);
  if (name !== undefined) {
    if (seen.has(name)) return undefined;
    const target = openapi.components.schemas[name];
    if (typeof target !== 'object' || target === null || Array.isArray(target)) return undefined;
    const nextSeen = new Set(seen);
    nextSeen.add(name);
    return resolveParameterSchema(target as SchemaRef, nextSeen);
  }
  if (schema.$ref !== undefined) return undefined;
  if (schema.anyOf?.length) {
    const members = schema.anyOf.flatMap((member) => {
      const resolved = resolveParameterSchema(member, seen);
      return resolved === undefined ? [] : [resolved];
    });
    const types = new Set(members.map(extractType).filter((type) => type !== 'unknown'));
    if (types.size === 1) return members[0];
    if (
      typeof schema.example === 'string' ||
      typeof schema.example === 'number' ||
      typeof schema.example === 'boolean'
    ) {
      return schema;
    }
    if (types.size === 2 && types.has('string') && types.has('array')) {
      const array = members.find((member) => extractType(member) === 'array');
      if (extractType(resolveParameterSchema(array?.items, seen)) === 'string') {
        return members.find((member) => extractType(member) === 'string');
      }
    }
    return undefined;
  }
  if (schema.oneOf?.length) {
    const members = schema.oneOf.flatMap((member) => {
      const resolved = resolveParameterSchema(member, seen);
      return resolved === undefined ? [] : [resolved];
    });
    const types = new Set(members.map(extractType).filter((type) => type !== 'unknown'));
    if (types.size === 1) return members[0];
    return undefined;
  }
  if (schema.allOf?.length) {
    const members = schema.allOf.flatMap((member) => {
      const resolved = resolveParameterSchema(member, seen);
      return resolved === undefined ? [] : [resolved];
    });
    const types = new Set(members.map(extractType).filter((type) => type !== 'unknown'));
    if (types.size > 1) return undefined;
    if (members.length > 0) {
      const { allOf: _, ...base } = schema;
      return Object.assign(base, ...members);
    }
  }
  return schema;
}

function resolveParameter(param: Parameter): ResolvedParameter | null {
  if (param.$ref) {
    const match = param.$ref.match(/#\/components\/parameters\/(.+)/);
    if (match && match[1]) {
      const resolved = openapi.components.parameters?.[match[1]];
      if (resolved && resolved.name && resolved.in) {
        return resolved as ResolvedParameter;
      }
    }
    return null;
  }
  if (param.name && param.in) {
    return param as ResolvedParameter;
  }
  return null;
}

function mergeParameters(
  pathParameters: Parameter[] | undefined,
  operationParameters: Parameter[] | undefined,
): Parameter[] {
  const merged = new Map<string, Parameter>();
  let unresolvedIndex = 0;

  for (const parameter of [...(pathParameters ?? []), ...(operationParameters ?? [])]) {
    const resolved = resolveParameter(parameter);
    const key = resolved ? resolved.in + ':' + resolved.name : 'unresolved:' + unresolvedIndex++;
    merged.set(key, parameter);
  }

  return [...merged.values()];
}

function extractParameters(params: Parameter[] | undefined, location: 'path' | 'query' | 'header'): ParameterInfo[] {
  if (!params) return [];
  return params
    .map(resolveParameter)
    .filter((p): p is ResolvedParameter => p !== null && p.in === location)
    .map((p) => {
      // Keep component identity separate from the resolved wire type.
      const schemaRef = componentSchemaName(p.schema);
      const referencedSchema = p.schema?.$ref ? resolveSchemaRef(p.schema) : undefined;
      const resolvedSchema = resolveParameterSchema(p.schema);
      const info: ParameterInfo = {
        name: p.name,
        required: p.required ?? false,
        type: location === 'path' ? 'string' : extractType(resolvedSchema),
      };
      if (p.schema?.oneOf?.length || p.schema?.anyOf?.length) info.composed = true;
      if (resolvedSchema?.type === 'array') {
        const itemSchema = resolveParameterSchema(resolvedSchema.items);
        info.itemType = extractType(itemSchema);
        if (itemSchema?.enum && Array.isArray(itemSchema.enum)) {
          info.itemEnumValues = itemSchema.enum.flatMap((value: unknown) =>
            typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? [String(value)] : [],
          );
        }
      }
      if (schemaRef !== undefined) info.schemaRef = schemaRef;
      // Description: prefer parameter-level, then the reference shell and target.
      const desc =
        p.description ?? p.schema?.description ?? referencedSchema?.description ?? resolvedSchema?.description;
      if (desc) info.description = desc.trim();
      // Extract enum values from schema — check the resolved schema ($ref target) first,
      // then the original schema (for inline enums without $ref)
      const enumSchema = resolvedSchema?.enum ? resolvedSchema : p.schema;
      if (enumSchema && 'enum' in enumSchema && Array.isArray(enumSchema.enum)) {
        info.enumValues = enumSchema.enum.flatMap((value: unknown) =>
          typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? [String(value)] : [],
        );
      }
      // Default — same precedence as enum: $ref target first, then inline.
      const defaultSchema = resolvedSchema?.default !== undefined ? resolvedSchema : p.schema;
      if (
        defaultSchema &&
        'default' in defaultSchema &&
        defaultSchema.default !== undefined &&
        (typeof defaultSchema.default === 'string' ||
          typeof defaultSchema.default === 'number' ||
          typeof defaultSchema.default === 'boolean')
      ) {
        info.default = defaultSchema.default;
      }
      if (resolvedSchema?.['x-sensitive'] === true || p.schema?.['x-sensitive'] === true) {
        info.sensitive = true;
      }
      return info;
    });
}

/**
 * Resolve a `$ref` to the actual schema object.
 * Supports `#/components/schemas/...` references.
 *
 * Exported so consumers walking `OperationInfo.responses[*].content[*].schema`
 * can dereference nested `$ref`s on demand. The resolver only follows the
 * top-level ref when populating that map; nested refs are left raw to keep
 * the structure shareable and finite for cyclic component schemas.
 */
export function resolveSchemaRef(schema: SchemaRef): SchemaRef {
  if (!schema.$ref) return schema;
  const match = schema.$ref.match(/#\/components\/schemas\/(.+)/);
  if (match && match[1]) {
    const resolved = openapi.components.schemas[match[1]] as SchemaRef | undefined;
    if (resolved) return resolved;
  }
  return schema;
}

/**
 * Recursively dereference any `$ref` that points into the loaded OpenAPI doc.
 *
 * Unlike {@link resolveSchemaRef}, this walks arbitrary `#/...` paths
 * (request bodies, parameters, response objects, examples, etc.) and
 * recurses if the resolved target itself contains a top-level `$ref`.
 * Returns the original value unchanged when the input has no `$ref` or
 * the path can't be walked.
 *
 * Exported so consumers can resolve nested `$ref`s inside the resolved
 * schemas surfaced by `OperationInfo.responses`.
 */
export function resolveDocRef<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  const obj = value as { $ref?: string } & Record<string, unknown>;
  if (typeof obj.$ref !== 'string') return value;
  const parts = obj.$ref.replace(/^#\//, '').split('/');
  let cur: unknown = openapi;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return value;
    cur = (cur as Record<string, unknown>)[p];
    if (cur == null) return value;
  }
  return resolveDocRef(cur as T);
}

function isSemanticallyEmptyRequestBody(requestBody: RequestBody): boolean {
  const content = requestBody.content;
  if (!content) return false;
  const mediaEntries = Object.entries(content);
  if (mediaEntries.length === 0) return true;
  return mediaEntries.every(([contentType, media]) => {
    if (!contentType.toLowerCase().includes('json')) return false;
    const schema = media?.schema;
    if (!schema) return true;
    if (schema.$ref) return false;
    const structuralKeys = Object.keys(schema).filter(
      (key) => !['description', 'title', 'example', 'examples', 'deprecated', 'readOnly', 'writeOnly'].includes(key),
    );
    return structuralKeys.length === 0 || (structuralKeys.length === 1 && schema.type === 'object');
  });
}

/**
 * Read the request-body description for an operation.
 *
 * Tries `requestBody.description` first; falls back to the description of
 * one of the body's content schemas, in
 * application/json → application/octet-stream → multipart/form-data order.
 */
function extractRequestBodyDescription(requestBody: RequestBody | undefined): string | undefined {
  if (!requestBody) return undefined;
  const body = resolveDocRef(requestBody);
  if (typeof body.description === 'string' && body.description.length > 0) {
    return body.description;
  }
  const content = body.content;
  if (!content) return undefined;
  const schema =
    resolveDocRef(content['application/json']?.schema) ??
    resolveDocRef(content['application/octet-stream']?.schema) ??
    resolveDocRef(content['multipart/form-data']?.schema);
  if (schema && typeof schema.description === 'string' && schema.description.length > 0) {
    return schema.description;
  }
  return undefined;
}

/**
 * Walk the `multipart/form-data` request-body schema and return its declared
 * fields plus which one (if any) is the primary payload.
 *
 * Returns undefined when the operation has no multipart body or the schema
 * uses a dynamic-key shape (`additionalProperties: ...`) that can't be
 * translated to fixed flags.
 *
 * Payload-field detection priority:
 *   1. Field whose raw `$ref` equals the `application/octet-stream` schema's
 *      raw `$ref` (e.g. KV's `value: workers-kv_value` pairs with the
 *      octet-stream `workers-kv_value` body).
 *   2. First field with `format: binary`.
 *   3. Field literally named `"file"`.
 */
function extractMultipart(requestBody: RequestBody | undefined): MultipartInfo | undefined {
  if (!requestBody) return undefined;
  const body = resolveDocRef(requestBody);
  const multipartRaw = body.content?.['multipart/form-data']?.schema;
  const schema = resolveDocRef(multipartRaw);
  if (!schema || !schema.properties || typeof schema.properties !== 'object') {
    return undefined;
  }

  const octetRaw = body.content?.['application/octet-stream']?.schema;
  const octetRef = octetRaw?.$ref;

  const required = new Set<string>(Array.isArray(schema.required) ? schema.required.map(String) : []);

  const fields: MultipartField[] = [];
  let payloadField: string | undefined;

  for (const [propName, rawProp] of Object.entries(schema.properties)) {
    if (!rawProp) continue;
    const prop = resolveDocRef(rawProp);
    const isBinary = prop.format === 'binary';

    let type: MultipartField['type'] = 'string';
    if (prop.type === 'number' || prop.type === 'integer') type = 'number';
    else if (prop.type === 'boolean') type = 'boolean';
    else if (prop.type === 'array') type = 'array';
    else if (prop.type === 'object') type = 'object';

    fields.push({
      name: propName,
      type,
      isBinary,
      required: required.has(propName),
      description: typeof prop.description === 'string' ? prop.description : `The ${propName.replace(/_/g, ' ')}`,
    });

    if (!payloadField) {
      const propRef = rawProp.$ref;
      if (octetRef && propRef && octetRef === propRef) {
        payloadField = propName;
      } else if (isBinary) {
        payloadField = propName;
      } else if (propName === 'file') {
        payloadField = propName;
      }
    }
  }

  return { fields, payloadField };
}

/**
 * Extract `maxItems` from an array-shaped request body. Returns the schema's
 * `maxItems` when the body itself is `type: array`; undefined for non-array
 * bodies and arrays without a cap.
 */
function extractBodyMaxItems(requestBody: RequestBody | undefined): number | undefined {
  if (!requestBody) return undefined;
  const body = resolveDocRef(requestBody);
  const schema = resolveDocRef(body.content?.['application/json']?.schema);
  if (!schema) return undefined;
  if (schema.type !== 'array') return undefined;
  return typeof schema.maxItems === 'number' ? schema.maxItems : undefined;
}

/**
 * Extract array-body info for an `application/json` request body. Returns
 * `{ isArray: false, itemRef: null }` for non-JSON bodies, unresolvable
 * bodies, or non-array bodies. When the body is `type: array`, attempts to
 * extract the items' `$ref` so consumers can emit `Array<itemRef>` types.
 *
 * Mirrors the response-side `deriveJsonEnvelopeInfo`'s isArray/itemRef pair.
 */
function extractArrayBodyInfo(requestBody: RequestBody | undefined): {
  isArray: boolean;
  itemRef: string | null;
} {
  if (!requestBody) return { isArray: false, itemRef: null };
  const body = resolveDocRef(requestBody);
  const schema = resolveDocRef(body.content?.['application/json']?.schema);
  if (!schema || schema.type !== 'array') return { isArray: false, itemRef: null };
  const itemRef = schema.items ? extractRef(schema.items) : null;
  return { isArray: true, itemRef };
}

/**
 * Extract the names of fields required at the root of an `application/json`
 * request body. Returns an empty array for non-JSON bodies, unresolvable
 * bodies, or schemas that lack a top-level `required` array.
 *
 * Walks `allOf` to collect inherited `required` entries (the same merging
 * `extractBodyProperties` does internally); doesn't walk `oneOf` (that's
 * for `bodyDiscriminator` to surface).
 *
 * Consumers (notably the cf generator's flat-flag namespace) use this to
 * distinguish "this object is optional at the parent — its inner required
 * fields are required-when-present" from "this object is required at the
 * parent — its inner required fields are unconditionally required".
 */
function extractRequestBodyRequired(requestBody: RequestBody | undefined): string[] {
  if (!requestBody) return [];
  const body = resolveDocRef(requestBody);
  const schema = resolveDocRef(body.content?.['application/json']?.schema);
  if (!schema || schema.type === 'array') return [];
  const required = new Set<string>();
  const collectRequired = (s: SchemaRef): void => {
    const r = resolveDocRef(s);
    if (!r) return;
    if (Array.isArray(r.required)) {
      for (const name of r.required) {
        if (typeof name === 'string') required.add(name);
      }
    }
    if (Array.isArray(r.allOf)) {
      for (const sub of r.allOf) {
        if (sub) collectRequired(sub);
      }
    }
  };
  collectRequired(schema);
  return [...required];
}

/**
 * Extract discriminated-`oneOf` body variant info.
 *
 * Returns the discriminator field name and a map from each discriminator
 * enum value to the list of *variant-specific* required API fields (i.e.
 * excluding fields required across all variants — those already appear in
 * `bodyParams` with `required: true`).
 *
 * Returns undefined when the body is not a discriminated `oneOf`, can't be
 * resolved, or lacks a proper discriminator / mapping.
 */
function extractBodyDiscriminator(requestBody: RequestBody | undefined): BodyDiscriminator | undefined {
  if (!requestBody) return undefined;
  const body = resolveDocRef(requestBody);
  const jsonSchema = resolveDocRef(body.content?.['application/json']?.schema);
  if (!jsonSchema?.oneOf) return undefined;
  const discriminator = jsonSchema.discriminator;
  if (!discriminator?.propertyName) return undefined;
  const field = discriminator.propertyName;

  // Collect each variant's required set, keyed by discriminator value.
  const variantRequireds: { value: string; required: string[] }[] = [];
  for (const variantRef of jsonSchema.oneOf) {
    const variant = resolveDocRef(variantRef);
    if (!variant?.properties) continue;
    // Discriminator value: prefer the variant's own singleton-enum on the
    // discriminator property; fall back to looking up `discriminator.mapping`
    // by the variant's `$ref`.
    const discProp = resolveDocRef(variant.properties[field]);
    let value: string | null = null;
    if (
      discProp &&
      Array.isArray(discProp.enum) &&
      discProp.enum.length === 1 &&
      typeof discProp.enum[0] === 'string'
    ) {
      value = discProp.enum[0];
    } else if (discriminator.mapping) {
      const ref = variantRef.$ref;
      for (const [k, v] of Object.entries(discriminator.mapping)) {
        if (v === ref) {
          value = k;
          break;
        }
      }
    }
    if (value == null) continue;
    const required = Array.isArray(variant.required) ? variant.required.map(String) : [];
    variantRequireds.push({ value, required });
  }
  if (variantRequireds.length === 0) return undefined;

  // Intersection across all variants = common required (already on bodyParams).
  let common: Set<string> | null = null;
  for (const v of variantRequireds) {
    if (common === null) {
      common = new Set(v.required);
    } else {
      const prev: Set<string> = common;
      common = new Set(v.required.filter((r) => prev.has(r)));
    }
  }
  const commonSet = common ?? new Set<string>();

  const variants: Record<string, string[]> = {};
  for (const v of variantRequireds) {
    variants[v.value] = v.required.filter((r) => !commonSet.has(r));
  }
  return { field, variants };
}

/**
 * Flatten an allOf composition into a single merged schema.
 * Merges properties and required arrays from all sub-schemas.
 */
function flattenAllOf(schemas: SchemaRef[]): SchemaRef {
  const merged: SchemaRef = { type: 'object', properties: {}, required: [] };
  for (const s of schemas) {
    const resolved = resolveSchemaRef(s);
    if (resolved.properties) {
      for (const [key, val] of Object.entries(resolved.properties)) {
        if (val) merged.properties![key] = val;
      }
    }
    if (resolved.required) {
      merged.required = [...(merged.required ?? []), ...resolved.required];
    }
    // Propagate oneOf from allOf members (e.g. allOf: [{ $ref: schema-with-oneOf }])
    if (resolved.oneOf && !merged.oneOf) {
      merged.oneOf = resolved.oneOf;
    }
    // Propagate description
    if (resolved.description && !merged.description) {
      merged.description = resolved.description;
    }
    // Recurse into nested allOf
    if (resolved.allOf) {
      const nested = flattenAllOf(resolved.allOf);
      if (nested.properties) {
        for (const [key, val] of Object.entries(nested.properties)) {
          if (val) merged.properties![key] = val;
        }
      }
      if (nested.required) {
        merged.required = [...(merged.required ?? []), ...nested.required];
      }
      if (nested.oneOf && !merged.oneOf) {
        merged.oneOf = nested.oneOf;
      }
    }
  }
  // Deduplicate required
  merged.required = [...new Set(merged.required)];
  return merged;
}

/**
 * Convert a snake_case or camelCase name to kebab-case for CLI flag names.
 */
function toKebabCase(name: string): string {
  return name
    .replace(/_/g, '-')
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

function isObjectValuedSchema(schema: SchemaRef, active = new Set<SchemaRef>()): boolean {
  if (active.has(schema)) return false;
  const nextActive = new Set(active);
  nextActive.add(schema);

  const resolved = resolveSchemaRef(schema);
  if (resolved !== schema) return isObjectValuedSchema(resolved, nextActive);
  if (resolved.type === 'object' || resolved.properties !== undefined) return true;
  if (resolved.oneOf?.length) {
    return resolved.oneOf.every((variant) => isObjectValuedSchema(variant, nextActive));
  }
  if (resolved.anyOf?.length) {
    return resolved.anyOf.every((variant) => isObjectValuedSchema(variant, nextActive));
  }
  if (resolved.allOf?.length) {
    return resolved.allOf.some((member) => isObjectValuedSchema(member, nextActive));
  }
  return false;
}

/**
 * Convert a schema array into a body parameter. Scalar arrays retain their
 * existing repeatable-value representation. A direct request-body array of
 * objects is marked with `itemType: 'object'` so consumers can accept one JSON
 * string, parse it, and reconstruct the original array at `apiFieldPath`.
 */
function createArrayBodyParam(
  arraySchema: SchemaRef,
  rawArraySchema: SchemaRef,
  name: string,
  apiFieldPath: string[],
  required: boolean,
): BodyParamInfo | undefined {
  if (!arraySchema.items) return undefined;

  const items = resolveSchemaRef(arraySchema.items);
  const hasScalarItems = items.type === 'string' || items.type === 'number' || items.type === 'integer';
  const hasObjectItems = apiFieldPath.length === 1 && isObjectValuedSchema(arraySchema.items);
  if (!hasScalarItems && !hasObjectItems) return undefined;

  const info: BodyParamInfo = {
    name,
    required,
    type: 'array',
    apiFieldPath,
  };
  if (hasObjectItems) info.itemType = 'object';
  if (arraySchema.description) info.description = arraySchema.description;
  if (arraySchema['x-sensitive'] === true || rawArraySchema['x-sensitive'] === true) {
    info.sensitive = true;
  }
  return info;
}

/**
 * Extract body properties as flat CLI parameters from a resolved schema.
 * Recursively flattens nested objects with kebab-prefixed names.
 *
 * @param schema - The resolved schema to extract from
 * @param prefix - Kebab-case prefix for nested properties (e.g. 'origin')
 * @param fieldPath - API field path for body reconstruction (e.g. ['origin'])
 * @param requiredSet - Set of required property names at this level
 * @param depth - Current nesting depth (max 3 to avoid infinite recursion)
 */
function extractPropertiesFromSchema(
  schema: SchemaRef,
  prefix: string,
  fieldPath: string[],
  requiredSet: Set<string>,
  depth: number,
): BodyParamInfo[] {
  if (depth > 3) return [];
  const results: BodyParamInfo[] = [];
  if (!schema.properties) return results;

  for (const [propName, propSchema] of Object.entries(schema.properties)) {
    if (!propSchema) continue;
    const resolved = resolveSchemaRef(propSchema);

    // Skip readOnly fields (e.g. id, created_on, modified_on)
    if (resolved.readOnly) continue;

    // Skip property names with special characters that can't be valid JS identifiers or CLI flags
    if (/[/~.[\]{}()]/.test(propName)) continue;

    const flagName = prefix ? `${prefix}-${toKebabCase(propName)}` : toKebabCase(propName);
    const currentPath = [...fieldPath, propName];
    const isRequired = requiredSet.has(propName);

    // Determine the type
    const resolvedType = resolved.type;

    // Property-level `oneOf` (e.g. infra_ServiceHost — non-discriminated union of
    // host shapes). Mirrors the top-level dispatch in extractBodyProperties so
    // these reach deriveOneOfConstraints instead of being silently dropped.
    if (resolved.oneOf) {
      const oneOfParams = deriveOneOfConstraints(resolved.oneOf, flagName, currentPath, depth + 1);
      results.push(...oneOfParams);
      continue;
    }

    // Property-level `allOf` whose merge yields a `oneOf` — same dispatch.
    // The non-oneOf `allOf` case is handled by the object branch below.
    if (resolved.allOf) {
      const merged = flattenAllOf(resolved.allOf);
      if (merged.oneOf) {
        const oneOfParams = deriveOneOfConstraints(merged.oneOf, flagName, currentPath, depth + 1);
        results.push(...oneOfParams);
        continue;
      }
    }

    if (resolvedType === 'object' || resolved.properties || resolved.allOf) {
      // Nested object — recurse to flatten
      let nestedSchema = resolved;
      if (resolved.allOf) {
        nestedSchema = flattenAllOf(resolved.allOf);
      }
      const nestedRequired = new Set(nestedSchema.required ?? []);
      const nestedResults = extractPropertiesFromSchema(nestedSchema, flagName, currentPath, nestedRequired, depth + 1);
      results.push(...nestedResults);
    } else if (
      resolvedType === 'string' ||
      resolvedType === 'number' ||
      resolvedType === 'integer' ||
      resolvedType === 'boolean'
    ) {
      // Scalar property — create a CLI flag
      const info: BodyParamInfo = {
        name: flagName,
        required: isRequired,
        type: resolvedType === 'integer' ? 'number' : resolvedType,
        apiFieldPath: currentPath,
      };
      if (resolved.description) info.description = resolved.description;
      if (resolved.enum && Array.isArray(resolved.enum)) {
        info.enumValues = resolved.enum.filter((v): v is string => typeof v === 'string' && v !== '');
      }
      if (
        resolved.default !== undefined &&
        (typeof resolved.default === 'string' ||
          typeof resolved.default === 'number' ||
          typeof resolved.default === 'boolean')
      ) {
        info.default = resolved.default;
      }
      if (resolved['x-sensitive'] === true || propSchema['x-sensitive'] === true) {
        info.sensitive = true;
      }
      results.push(info);
    } else if (resolvedType === 'array' && resolved.items) {
      const info = createArrayBodyParam(resolved, propSchema, flagName, currentPath, isRequired);
      if (info) results.push(info);
    }
    // Skip unknown / complex types silently (they stay in --body territory)
  }

  return results;
}

/**
 * Collect every property name (top-level plus leaf names under nested object
 * properties) that this variant contributes to the flag namespace. Used to
 * compute pair-wise variant uniqueness for conflicts derivation.
 */
function collectVariantPropNames(schema: SchemaRef, depth = 0): Set<string> {
  const names = new Set<string>();
  if (depth > 3) return names;
  const props = schema.properties;
  if (!props) return names;
  for (const [name, sub] of Object.entries(props)) {
    if (!sub) continue;
    names.add(name);
    let resolved = resolveSchemaRef(sub);
    if (resolved.allOf) resolved = flattenAllOf(resolved.allOf);
    if (resolved.type === 'object' || resolved.properties) {
      for (const deep of collectVariantPropNames(resolved, depth + 1)) {
        names.add(deep);
      }
    }
  }
  return names;
}

/**
 * Merge the values of two enum schemas, resolving component references first.
 * The resolved first schema remains the base so its annotations (including a
 * default) retain the existing first-variant precedence.
 */
function mergeEnumSchemas(a: SchemaRef, b: SchemaRef): SchemaRef | null {
  const resolvedA = resolveSchemaRef(a);
  const resolvedB = resolveSchemaRef(b);
  if (!Array.isArray(resolvedA.enum) || !Array.isArray(resolvedB.enum)) return null;

  return {
    ...resolvedA,
    enum: [...new Set([...resolvedA.enum, ...resolvedB.enum])],
  };
}

/**
 * Deep-merge two schemas when both are object-typed with `properties`. Used
 * when two `oneOf` variants share a property name with overlapping but
 * non-identical sub-shapes — the union of sub-properties becomes the merged
 * sub-shape, the intersection of `required` becomes the merged `required`.
 *
 * Returns null when the two schemas aren't both object-typed (caller falls
 * back to first-wins behaviour).
 */
function deepMergeObjectSchemas(a: SchemaRef, b: SchemaRef): SchemaRef | null {
  let resolvedA = resolveSchemaRef(a);
  let resolvedB = resolveSchemaRef(b);
  if (resolvedA.allOf) resolvedA = flattenAllOf(resolvedA.allOf);
  if (resolvedB.allOf) resolvedB = flattenAllOf(resolvedB.allOf);

  const aIsObject = resolvedA.type === 'object' || resolvedA.properties !== undefined;
  const bIsObject = resolvedB.type === 'object' || resolvedB.properties !== undefined;
  if (!aIsObject || !bIsObject) return null;

  const mergedProps: Record<string, SchemaRef | undefined> = { ...resolvedA.properties };
  for (const [key, val] of Object.entries(resolvedB.properties ?? {})) {
    if (!val) continue;
    const existing = mergedProps[key];
    if (!existing) {
      mergedProps[key] = val;
      continue;
    }
    // Recurse for nested objects
    const recursed = deepMergeObjectSchemas(existing, val);
    if (recursed) {
      mergedProps[key] = recursed;
    } else {
      const mergedEnum = mergeEnumSchemas(existing, val);
      if (mergedEnum) mergedProps[key] = mergedEnum;
    }
    // Otherwise first-wins (existing already in mergedProps)
  }

  // Required is the intersection: a field is required in the merged schema
  // only if it was required in BOTH variants.
  const aRequired = new Set(resolvedA.required ?? []);
  const bRequired = resolvedB.required ?? [];
  const mergedRequired = bRequired.filter((r) => aRequired.has(r));

  const merged: SchemaRef = { type: 'object', properties: mergedProps, required: mergedRequired };
  if (resolvedA.description) merged.description = resolvedA.description;
  return merged;
}

/**
 * Derive conflicts and co-required (implies) constraints from oneOf variants.
 *
 * For each pair of variants, fields unique to one variant conflict with fields
 * unique to the other. Within a variant, fields that are required together
 * (beyond the common required set) imply each other.
 */
function deriveOneOfConstraints(
  variants: SchemaRef[],
  prefix: string,
  fieldPath: string[],
  depth: number,
): BodyParamInfo[] {
  if (depth > 3) return [];

  // Resolve and flatten each variant. propNames includes deep leaf names
  // (via collectVariantPropNames) so the conflicts diff below picks up
  // sub-fields unique to one variant, not just top-level property names.
  const resolvedVariants: {
    schema: SchemaRef;
    propNames: Set<string>;
    requiredNames: Set<string>;
  }[] = [];
  for (const variant of variants) {
    let resolved = resolveSchemaRef(variant);
    if (resolved.allOf) {
      resolved = flattenAllOf(resolved.allOf);
    }
    const propNames = collectVariantPropNames(resolved);
    const requiredNames = new Set(resolved.required ?? []);
    resolvedVariants.push({ schema: resolved, propNames, requiredNames });
  }

  // Collect all property names across all variants
  const allPropNames = new Set<string>();
  for (const v of resolvedVariants) {
    for (const name of v.propNames) allPropNames.add(name);
  }

  // Find common required (intersection of all variants' required)
  let commonRequired: Set<string> | null = null;
  for (const v of resolvedVariants) {
    if (commonRequired === null) {
      commonRequired = new Set(v.requiredNames);
    } else {
      for (const name of commonRequired) {
        if (!v.requiredNames.has(name)) commonRequired.delete(name);
      }
    }
  }
  commonRequired = commonRequired ?? new Set();

  // Extract params from the union of all variant properties.
  // A property is required only if it's in the common required set.
  //
  // Merge strategy when the same property appears in multiple variants:
  //   1. Both schemas are object-typed → deep-merge sub-properties (union)
  //      and intersect their `required` lists. Required for cases like
  //      mq_consumer-request where worker and http_pull variants both
  //      declare a top-level `settings` object with disjoint sub-fields
  //      (`max_concurrency` etc. vs `visibility_timeout_ms`); without
  //      deep-merge the second variant's sub-fields are silently dropped.
  //   2. Both schemas declare an `enum` → union the enum values so the
  //      generated flag accepts any variant's value (e.g. `type` accepts
  //      both "secret_text" and "secret_key").
  //   3. Otherwise first-wins (the first variant's schema is the base, so
  //      its `default` is preserved on primitive conflicts).
  const mergedProperties: Record<string, SchemaRef> = {};
  for (const v of resolvedVariants) {
    for (const [name, schema] of Object.entries(v.schema.properties ?? {})) {
      if (!schema) continue;
      const existing = mergedProperties[name];
      if (!existing) {
        mergedProperties[name] = schema;
        continue;
      }
      const deepMerged = deepMergeObjectSchemas(existing, schema);
      if (deepMerged) {
        mergedProperties[name] = deepMerged;
      } else {
        const mergedEnum = mergeEnumSchemas(existing, schema);
        if (mergedEnum) mergedProperties[name] = mergedEnum;
      }
    }
  }

  const mergedSchema: SchemaRef = {
    type: 'object',
    properties: mergedProperties,
    required: [...commonRequired],
  };
  const params = extractPropertiesFromSchema(mergedSchema, prefix, fieldPath, commonRequired, depth);

  // Build a mapping from API property name to flag name for constraint references
  const propToFlag = new Map<string, string>();
  for (const p of params) {
    const lastSegment = p.apiFieldPath[p.apiFieldPath.length - 1];
    if (lastSegment) propToFlag.set(lastSegment, p.name);
  }

  // Derive conflicts between variants
  for (let i = 0; i < resolvedVariants.length; i++) {
    for (let j = i + 1; j < resolvedVariants.length; j++) {
      const vi = resolvedVariants[i];
      const vj = resolvedVariants[j];
      if (!vi || !vj) continue;
      const uniqueToI = [...vi.propNames].filter((n) => !vj.propNames.has(n));
      const uniqueToJ = [...vj.propNames].filter((n) => !vi.propNames.has(n));

      if (uniqueToI.length > 0 && uniqueToJ.length > 0) {
        const flagsI = uniqueToI.map((n) => propToFlag.get(n)).filter((f): f is string => !!f);
        const flagsJ = uniqueToJ.map((n) => propToFlag.get(n)).filter((f): f is string => !!f);
        const setI = new Set(uniqueToI);
        const setJ = new Set(uniqueToJ);

        // Each flag in I conflicts with all flags in J, and vice versa
        for (const param of params) {
          const lastSegment = param.apiFieldPath[param.apiFieldPath.length - 1];
          if (!lastSegment) continue;
          if (setI.has(lastSegment)) {
            param.conflicts = [...new Set([...(param.conflicts ?? []), ...flagsJ])];
          }
          if (setJ.has(lastSegment)) {
            param.conflicts = [...new Set([...(param.conflicts ?? []), ...flagsI])];
          }
        }
      }
    }
  }

  // Skip implies for fields required in more than one variant. Those
  // fields don't tell us which variant the user picked, so we can't
  // require any other field along with them. e.g. Hyperdrive `host` is
  // required in two variants; the real rule is `host` needs either
  // `port`, or `access-client-id` AND `access-client-secret` — a single
  // implies list can only say AND, not OR.
  const variantSpecificRequiredCount = new Map<string, number>();
  for (const v of resolvedVariants) {
    for (const name of v.requiredNames) {
      if (commonRequired?.has(name)) continue;
      variantSpecificRequiredCount.set(name, (variantSpecificRequiredCount.get(name) ?? 0) + 1);
    }
  }

  for (const v of resolvedVariants) {
    const variantSpecificRequired = [...v.requiredNames].filter((n) => !commonRequired?.has(n));
    if (variantSpecificRequired.length > 1) {
      for (const propName of variantSpecificRequired) {
        if ((variantSpecificRequiredCount.get(propName) ?? 0) > 1) continue;
        const flag = propToFlag.get(propName);
        if (!flag) continue;
        const param = params.find((p) => p.name === flag);
        if (!param) continue;
        const others = variantSpecificRequired
          .filter((n) => n !== propName)
          .map((n) => propToFlag.get(n))
          .filter((f): f is string => !!f);
        if (others.length > 0) {
          param.implies = [...new Set([...(param.implies ?? []), ...others])];
        }
      }
    }
  }

  return params;
}

/**
 * Extract request body properties as CLI-friendly flat parameters.
 * Resolves $ref chains, flattens allOf compositions, recursively flattens
 * nested objects, and derives oneOf constraints (conflicts/implies).
 */
function extractBodyProperties(requestBody: Operation['requestBody']): BodyParamInfo[] {
  const jsonSchema = requestBody?.content?.['application/json']?.schema;
  if (!jsonSchema) return [];

  let resolved = resolveSchemaRef(jsonSchema);

  // Handle allOf at the top level (common pattern: merge multiple schemas)
  if (resolved.allOf) {
    resolved = flattenAllOf(resolved.allOf);
  }

  // Handle top-level oneOf (e.g. R2 sippy — entire body is a oneOf)
  if (resolved.oneOf && !resolved.properties) {
    return deriveOneOfConstraints(resolved.oneOf, '', [], 0);
  }

  const requiredSet = new Set(resolved.required ?? []);
  const results: BodyParamInfo[] = [];

  if (resolved.properties) {
    for (const [propName, propSchema] of Object.entries(resolved.properties)) {
      if (!propSchema) continue;
      const propResolved = resolveSchemaRef(propSchema);

      // Skip readOnly fields
      if (propResolved.readOnly) continue;

      const flagPrefix = toKebabCase(propName);
      const currentPath = [propName];
      const isRequired = requiredSet.has(propName);

      // Handle oneOf within a property (e.g. Hyperdrive origin, Vectorize config)
      if (propResolved.oneOf) {
        const oneOfParams = deriveOneOfConstraints(propResolved.oneOf, flagPrefix, currentPath, 1);
        results.push(...oneOfParams);
        continue;
      }

      // Handle allOf within a property
      if (propResolved.allOf) {
        const merged = flattenAllOf(propResolved.allOf);
        if (merged.oneOf) {
          const oneOfParams = deriveOneOfConstraints(merged.oneOf, flagPrefix, currentPath, 1);
          results.push(...oneOfParams);
        } else {
          const nestedRequired = new Set(merged.required ?? []);
          const nestedParams = extractPropertiesFromSchema(merged, flagPrefix, currentPath, nestedRequired, 1);
          results.push(...nestedParams);
        }
        continue;
      }

      // Handle nested object
      if (propResolved.type === 'object' || propResolved.properties) {
        const nestedRequired = new Set(propResolved.required ?? []);
        const nestedParams = extractPropertiesFromSchema(propResolved, flagPrefix, currentPath, nestedRequired, 1);
        results.push(...nestedParams);
        continue;
      }

      // Scalar / array property at top level
      const type = propResolved.type;
      if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean') {
        const info: BodyParamInfo = {
          name: flagPrefix,
          required: isRequired,
          type: type === 'integer' ? 'number' : type,
          apiFieldPath: currentPath,
        };
        if (propResolved.description) info.description = propResolved.description;
        if (propResolved.enum && Array.isArray(propResolved.enum)) {
          info.enumValues = propResolved.enum.filter((v): v is string => typeof v === 'string' && v !== '');
        }
        if (
          propResolved.default !== undefined &&
          (typeof propResolved.default === 'string' ||
            typeof propResolved.default === 'number' ||
            typeof propResolved.default === 'boolean')
        ) {
          info.default = propResolved.default;
        }
        if (propResolved['x-sensitive'] === true || propSchema['x-sensitive'] === true) {
          info.sensitive = true;
        }
        results.push(info);
      } else if (type === 'array' && propResolved.items) {
        const info = createArrayBodyParam(propResolved, propSchema, flagPrefix, currentPath, isRequired);
        if (info) results.push(info);
      }
    }
  }

  return results;
}

/**
 * Build the `responses` map for an operation.
 *
 * Walks every declared status code and every content-type underneath it,
 * resolves the top-level `$ref` of each body schema once, and records the
 * original ref string for type-name generation. Status codes are kept in
 * spec-literal form (`"200"`, `"4XX"`, `"default"`); media types are kept
 * verbatim (`"application/json"`, `"application/pdf"`, `"text/plain"`).
 */
function extractResponses(responses: Operation['responses']): Record<string, ResponseInfo> {
  const result: Record<string, ResponseInfo> = {};
  if (!responses) return result;

  for (const [status, rawResponse] of Object.entries(responses)) {
    if (!rawResponse) continue;
    // Response objects can themselves be `$ref`s into `#/components/responses/...`.
    const response = resolveDocRef(rawResponse);

    const info: ResponseInfo = { content: {} };
    if (typeof response.description === 'string' && response.description.length > 0) {
      info.description = response.description;
    }

    if (response.content) {
      for (const [mediaType, body] of Object.entries(response.content)) {
        if (!body) continue;
        info.content[mediaType] = extractResponseBody(body.schema);
      }
    }

    result[status] = info;
  }

  return result;
}

/**
 * Resolve a single response-body schema once at the top level and surface the
 * shape consumers care about: the resolved schema, the original ref (for
 * type-name generation), and array-ness with element ref.
 *
 * Nested `$ref`s inside the resolved schema are deliberately not followed;
 * consumers walking the schema can use `resolveDocRef` / `resolveSchemaRef`.
 */
function extractResponseBody(rawSchema: SchemaRef | undefined): ResponseBodyInfo {
  if (!rawSchema) {
    return { ref: null, isArray: false, itemRef: null };
  }
  const ref = extractRef(rawSchema);
  // Resolve the top-level $ref so consumers see real `type` / `properties`
  // / `enum` / `allOf` / etc. fields. Nested $refs stay raw.
  const resolved = rawSchema.$ref ? resolveSchemaRef(rawSchema) : rawSchema;
  const isArray = resolved.type === 'array';
  const itemRef = isArray && resolved.items ? extractRef(resolved.items) : null;
  return { schema: resolved, ref, isArray, itemRef };
}

/**
 * Derive the legacy SDK-transformer fields (`responseRef`, `responseIsArray`,
 * `resultRef`) from the `responses['200'].content['application/json']` body.
 *
 * Preserves the pre-existing envelope-unwrap behaviour: when the JSON body
 * is `allOf: [api-response-common, { properties: { result: ... } }]`, the
 * inner `result` ref is surfaced as `resultRef`. For non-envelope or
 * non-JSON responses, callers should consult `OperationInfo.responses`
 * directly — these top-level fields cover only the JSON happy path.
 */
function deriveJsonEnvelopeInfo(responses: Record<string, ResponseInfo>): {
  responseRef: string | null;
  responseIsArray: boolean;
  resultRef: string | null;
} {
  const body = responses['200']?.content['application/json'];
  if (!body?.schema) {
    return { responseRef: null, responseIsArray: false, resultRef: null };
  }
  const schema = body.schema;

  // Envelope pattern: allOf includes a member with a `result` property.
  if (schema.allOf) {
    for (const item of schema.allOf) {
      if (item.properties?.result) {
        const resultSchema = item.properties.result;
        if (resultSchema.type === 'array' && resultSchema.items) {
          return {
            responseRef: body.ref,
            responseIsArray: true,
            resultRef: extractRef(resultSchema.items),
          };
        }
        return {
          responseRef: body.ref,
          responseIsArray: false,
          resultRef: extractRef(resultSchema),
        };
      }
    }
  }

  // Direct $ref to a component schema.
  if (body.ref) {
    return { responseRef: body.ref, responseIsArray: false, resultRef: null };
  }

  // Inline array body.
  if (body.isArray) {
    return { responseRef: null, responseIsArray: true, resultRef: body.itemRef };
  }

  return { responseRef: null, responseIsArray: false, resultRef: null };
}

/**
 * Populate the resolver's operationMap (and `$ref`-resolution spec) from the
 * given OpenAPI document. Called by `resolveApiOverlays` with the overlaid
 * spec so schema-level overlay patches reach `resolveOperation()`.
 */
export function populateOperationMap(value: unknown): void {
  if (!isOpenAPISpec(value)) {
    throw new Error('populateOperationMap: input is not a valid OpenAPI spec');
  }
  openapi = value;
  operationMap.clear();
  for (const [path, pathItem] of Object.entries(value.paths)) {
    const methods: Array<'get' | 'post' | 'put' | 'patch' | 'delete'> = ['get', 'post', 'put', 'patch', 'delete'];

    for (const method of methods) {
      const operation = pathItem[method];
      if (!operation?.operationId) continue;

      const responses = extractResponses(operation.responses);
      const envelopeInfo = deriveJsonEnvelopeInfo(responses);
      // Resolve `#/components/requestBodies/...` once before deriving body
      // metadata. Several consumers need content types and schemas, not the
      // reference shell itself.
      const resolvedRequestBody = operation.requestBody ? resolveDocRef(operation.requestBody) : undefined;
      const requestBody =
        resolvedRequestBody && !isSemanticallyEmptyRequestBody(resolvedRequestBody) ? resolvedRequestBody : undefined;
      const requestBodyDescription = extractRequestBodyDescription(requestBody);
      const multipart = extractMultipart(requestBody);
      const bodyDiscriminator = extractBodyDiscriminator(requestBody);
      const maxItems = extractBodyMaxItems(requestBody);
      const requestBodyRequired = extractRequestBodyRequired(requestBody);
      const arrayBodyInfo = extractArrayBodyInfo(requestBody);

      // Sanitize apostrophes from operationIds (some spec entries have them erroneously)
      const operationId = operation.operationId.replace(/'/g, '');
      const parameters = mergeParameters(pathItem.parameters, operation.parameters);
      const info: OperationInfo = {
        path,
        method,
        description: operation.description ?? '',
        pathParams: extractParameters(parameters, 'path'),
        queryParams: extractParameters(parameters, 'query'),
        headerParams: extractParameters(parameters, 'header'),
        bodyParams: extractBodyProperties(requestBody),
        hasRequestBody: !!requestBody,
        requestContentTypes: requestBody?.content ? Object.keys(requestBody.content) : [],
        requestBodyRef: extractRef(requestBody?.content?.['application/json']?.schema),
        requestBodyRequired,
        requestBodyIsArray: arrayBodyInfo.isArray,
        requestBodyArrayItemRef: arrayBodyInfo.itemRef,
        responses,
        ...envelopeInfo,
      };
      if (requestBodyDescription !== undefined) info.requestBodyDescription = requestBodyDescription;
      if (multipart !== undefined) info.multipart = multipart;
      if (bodyDiscriminator !== undefined) info.bodyDiscriminator = bodyDiscriminator;
      if (maxItems !== undefined) info.maxItems = maxItems;
      operationMap.set(operationId, info);
    }
  }
}

/**
 * Resolve an operation ID to its full information.
 * Apostrophes in the input are stripped to match the population key
 * (see populateOperationMap above), so callers can pass either the
 * literal spec id ("...-namespace'-s-keys") or the normalized one.
 */
export function resolveOperation(operationId: string): OperationInfo | undefined {
  return operationMap.get(operationId.replace(/'/g, ''));
}

/**
 * Get all operation IDs
 */
export function getAllOperationIds(): string[] {
  return Array.from(operationMap.keys());
}

/**
 * Check if an operation exists
 */
export function hasOperation(operationId: string): boolean {
  return operationMap.has(operationId);
}

/**
 * Pick the best matching response-key for an HTTP status code, following
 * OpenAPI 3 precedence: exact integer match → range bucket (`2XX`, `4XX`,
 * `5XX`, ...) → `default`. Returns `undefined` when no key matches.
 *
 * The OpenAPI 3 spec writes range buckets in uppercase (`2XX`); some real
 * specs use lowercase (`2xx`), so both are accepted.
 *
 * @see https://spec.openapis.org/oas/v3.1.0#responses-object
 *
 * @param status        Numeric HTTP status code (e.g. `401`, `503`).
 * @param availableKeys The status keys present on a response object —
 *                      typically `Object.keys(operationInfo.responses)`.
 *                      Order does not matter.
 */
export function matchResponseStatusKey(status: number, availableKeys: Iterable<string>): string | undefined {
  if (!Number.isInteger(status)) return undefined;
  const keys = new Set<string>();
  for (const k of availableKeys) keys.add(k);

  // 1. Exact integer match.
  const exact = String(status);
  if (keys.has(exact)) return exact;

  // 2. Range bucket. Status `401` matches `4XX` / `4xx`. `999` doesn't
  // map to a meaningful HTTP class so is treated as no-bucket.
  if (status >= 100 && status <= 599) {
    const bucketDigit = Math.floor(status / 100);
    const upper = `${bucketDigit}XX`;
    const lower = `${bucketDigit}xx`;
    if (keys.has(upper)) return upper;
    if (keys.has(lower)) return lower;
  }

  // 3. Default.
  if (keys.has('default')) return 'default';

  return undefined;
}

/**
 * Generate TypeScript type reference for an operation's response
 */
export function getResponseTypeRef(operationId: string): string {
  const info = resolveOperation(operationId);
  if (!info) return 'unknown';

  // Use the operations type helper
  return `operations['${operationId}']['responses']['200']['content']['application/json']`;
}

/**
 * Generate TypeScript type for the result field (unwrapped from API envelope)
 */
export function getResultTypeRef(operationId: string): string {
  const info = resolveOperation(operationId);
  if (!info) return 'unknown';

  if (info.resultRef) {
    if (info.responseIsArray) {
      return `${info.resultRef}[]`;
    }
    return info.resultRef;
  }

  // Fallback to full response type
  return getResponseTypeRef(operationId);
}
