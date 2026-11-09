/**
 * A model of the SDK request wrapper Fern's OpenAPI importer builds for an operation: the
 * properties of the generated request object (path parameters, query parameters, headers, and
 * inlined request body properties, or a single `body` property for a non-inlined body), with the
 * SDK names the importer assigns, including its automatic renames.
 *
 * The importer's behavior depends on whole-document analysis that cannot always be reproduced
 * statically (for example whether a body schema is inlined). Wherever the outcome is uncertain the
 * model leaves the affected properties out and over-approximates the names used for automatic
 * renames, so that consumers only see collisions that certainly exist.
 */
import type { OperationInfo, ParameterInfo } from './document.ts';
import { getJsonResponseSchema, getOperations, getRequestBody } from './document.ts';
import { headerSdkName, stringExtension } from './naming.ts';
import { streamingMode } from './property-path.ts';
import { isPlainObject, isRefNode, resolveChild, resolveNode } from './resolve.ts';
import { refName, schemaTypes } from './schema.ts';
import type { AnyNode, Located, Location, UserContext } from './types.ts';

type Ctx = Pick<UserContext, 'resolve'>;

export type WrapperItemKind =
  | 'path'
  | 'query'
  | 'header'
  | 'body-property'
  | 'inherited-property'
  | 'multipart-property'
  | 'request-body';

export interface WrapperItem {
  kind: WrapperItemKind;
  /** The SDK name of the request property. */
  name: string;
  /** The name as written in OpenAPI: parameter `name` or property key. */
  openapiName: string;
  /** The extension that set {@link name}, if any. */
  override?: 'x-fern-parameter-name' | 'x-fern-property-name';
  /** For inherited properties: the `allOf` `$ref` chain. */
  via?: string[];
  parameter?: ParameterInfo;
  location: Location;
}

const FERN_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

/** Headers Fern's OpenAPI importer never turns into SDK headers (compared lower-cased). */
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

const WRITE_METHODS = new Set(['post', 'put', 'patch']);

export interface RefOccurrence {
  /** Absolute pointer of the `$ref` node. */
  from: string;
  /** Absolute pointer of the resolved target. */
  to: string;
}

/** Whole-document facts the wrapper model needs. */
export interface DocumentFacts {
  operations: OperationInfo[];
  /** Header names dropped as auth headers (exact match). */
  authHeaders: Set<string>;
  /** Header names hoisted to global headers (exact match). */
  globalHeaders: Set<string>;
  /** `$ref` occurrences by target pointer. */
  refsByTarget: Map<string, string[]>;
  /** For each `$ref` target, the number of operations using it as the top-level body schema. */
  bodyRefUsers: Map<string, number>;
  /** Pointers of `$ref` nodes that are top-level body schemas. */
  bodyRefSources: Set<string>;
  /** Pointers of `$ref` nodes that are top-level JSON success response schemas. */
  responseRefSources: Set<string>;
}

export function isIgnored(node: AnyNode): boolean {
  return isPlainObject(node) && node['x-fern-ignore'] === true;
}

/** Operations Fern's OpenAPI importer turns into endpoints. */
export function fernOperations(ctx: Ctx, root: Located): OperationInfo[] {
  return getOperations(ctx, root).filter(
    (operation) => FERN_METHODS.has(operation.method) && !isIgnored(operation.node),
  );
}

function liveParameters(parameters: ParameterInfo[]): ParameterInfo[] {
  return parameters.filter((parameter) => !isIgnored(parameter.node));
}

/** Headers the importer drops because a security scheme provides them. */
export function securitySchemeHeaders(ctx: Ctx, root: Located): Set<string> {
  const result = new Set<string>();
  const components = resolveChild(ctx, root, 'components');
  const schemes = components === undefined ? undefined : resolveChild(ctx, components, 'securitySchemes');
  if (schemes === undefined || !isPlainObject(schemes.node)) {
    return result;
  }
  for (const name of Object.keys(schemes.node)) {
    const scheme = resolveChild(ctx, schemes, name)?.node;
    if (!isPlainObject(scheme)) {
      continue;
    }
    const httpScheme = typeof scheme.scheme === 'string' ? scheme.scheme.toLowerCase() : '';
    if (
      (scheme.type === 'http' && (httpScheme === 'bearer' || httpScheme === 'basic')) ||
      scheme.type === 'oauth2' ||
      scheme.type === 'openIdConnect'
    ) {
      result.add('Authorization');
    } else if (scheme.type === 'apiKey' && scheme.in === 'header' && typeof scheme.name === 'string') {
      result.add(scheme.name);
    }
  }
  return result;
}

/** Whether the importer keeps a header parameter at all. */
function isImportedHeader(parameter: ParameterInfo, authHeaders: Set<string>): boolean {
  return (
    parameter.in === 'header' && !HEADERS_TO_SKIP.has(parameter.name.toLowerCase()) && !authHeaders.has(parameter.name)
  );
}

function declaredGlobalHeaders(root: AnyNode): string[] {
  const result: string[] = [];
  const globalHeaders = isPlainObject(root) ? root['x-fern-global-headers'] : undefined;
  if (Array.isArray(globalHeaders)) {
    for (const header of globalHeaders) {
      if (isPlainObject(header) && typeof header.header === 'string') {
        result.push(header.header);
      }
    }
  }
  const version = isPlainObject(root) ? root['x-fern-version'] : undefined;
  if (isPlainObject(version)) {
    if (typeof version.header === 'string') {
      result.push(version.header);
    } else if (isPlainObject(version.header) && typeof version.header.value === 'string') {
      result.push(version.header.value);
    }
  }
  return result;
}

interface BodySchemaInfo {
  /** Where the request body schema (possibly a `$ref`) is written. */
  location: Location;
  node: AnyNode;
  kind: 'json' | 'form' | 'multipart';
}

interface RequestBodyKind {
  kind: 'none' | 'octet' | 'unknown' | 'json' | 'form' | 'multipart';
  schema?: BodySchemaInfo;
}

function parseMediaType(mediaType: string): { type: string; subtype: string } | undefined {
  const essence = mediaType.split(';')[0]!.trim().toLowerCase();
  const slash = essence.indexOf('/');
  if (slash <= 0 || slash === essence.length - 1) {
    return undefined;
  }
  return { type: essence.slice(0, slash), subtype: essence.slice(slash + 1) };
}

const BINARY_APPLICATION_SUBTYPES = new Set([
  'octet-stream',
  'pdf',
  'zip',
  'x-zip-compressed',
  'gzip',
  'x-gzip',
  'tar',
  'x-tar',
  'br',
]);

function isBinaryMediaType(mediaType: string): boolean {
  const parsed = parseMediaType(mediaType);
  if (parsed === undefined) {
    return false;
  }
  return (
    ['image', 'audio', 'video', 'font'].includes(parsed.type) ||
    (parsed.type === 'application' && BINARY_APPLICATION_SUBTYPES.has(parsed.subtype))
  );
}

function hasExamples(mediaTypeObject: AnyNode): boolean {
  return (
    isPlainObject(mediaTypeObject) &&
    (mediaTypeObject.example !== undefined ||
      (isPlainObject(mediaTypeObject.examples) && Object.keys(mediaTypeObject.examples).length > 0))
  );
}

function hasFileProperty(ctx: Ctx, schema: Located): boolean {
  const resolved = resolveNode(ctx, schema.node, schema.location);
  if (resolved === undefined || !isPlainObject(resolved.node)) {
    return false;
  }
  const properties = resolved.node.properties;
  if (!isPlainObject(properties)) {
    return false;
  }
  return Object.values(properties).some(
    (property) =>
      isPlainObject(property) &&
      !isRefNode(property) &&
      property.type === 'string' &&
      (property.format === 'binary' ||
        (property.format === undefined && property.contentMediaType === 'application/octet-stream')),
  );
}

/** Classifies the request body the way the importer picks a request type. */
function requestBodyKind(ctx: Ctx, operation: OperationInfo): RequestBodyKind {
  const requestBody = getRequestBody(ctx, operation);
  if (requestBody === undefined || !isPlainObject(requestBody.node)) {
    return { kind: 'none' };
  }
  const content = resolveChild(ctx, requestBody, 'content');
  if (content === undefined || !isPlainObject(content.node)) {
    return { kind: 'none' };
  }
  const mediaTypes = Object.keys(content.node);
  if (mediaTypes.length === 0) {
    return { kind: 'none' };
  }
  const mediaTypeObjects = new Map<string, Located>();
  for (const mediaType of mediaTypes) {
    const resolved = resolveChild(ctx, content, mediaType);
    if (resolved === undefined || !isPlainObject(resolved.node)) {
      return { kind: 'unknown' };
    }
    mediaTypeObjects.set(mediaType, resolved);
  }
  if (
    [...mediaTypeObjects.values()].every((mediaType) => typeof mediaType.node['x-fern-sdk-method-name'] === 'string')
  ) {
    return { kind: 'unknown' };
  }
  if (mediaTypes.some(isBinaryMediaType)) {
    return { kind: 'octet' };
  }
  const schemaOf = (mediaType: string | undefined, kind: BodySchemaInfo['kind']): BodySchemaInfo | undefined => {
    const located = mediaType === undefined ? undefined : mediaTypeObjects.get(mediaType);
    if (located === undefined || located.node.schema === undefined) {
      return undefined;
    }
    return {
      node: located.node.schema,
      location: located.location.child('schema'),
      kind,
    };
  };
  const jsonMediaType = mediaTypes.find((mediaType) => mediaType.includes('json') || mediaType === '*/*');
  const multipartMediaType = mediaTypes.find((mediaType) => parseMediaType(mediaType)?.type === 'multipart');
  const json = schemaOf(jsonMediaType, 'json');
  const multipart = schemaOf(multipartMediaType, 'multipart');
  if (json !== undefined && multipart !== undefined) {
    return hasFileProperty(ctx, json) ? { kind: 'multipart', schema: multipart } : { kind: 'json', schema: json };
  }
  if (json !== undefined) {
    return { kind: 'json', schema: json };
  }
  if (multipart !== undefined) {
    return { kind: 'multipart', schema: multipart };
  }
  if (jsonMediaType !== undefined && hasExamples(mediaTypeObjects.get(jsonMediaType)!.node)) {
    return { kind: 'unknown' };
  }
  const formMediaType = mediaTypes.find((mediaType) => {
    const parsed = parseMediaType(mediaType);
    return parsed?.type === 'application' && parsed.subtype === 'x-www-form-urlencoded';
  });
  const form = schemaOf(formMediaType, 'form');
  if (form !== undefined) {
    return { kind: 'form', schema: form };
  }
  return { kind: 'none' };
}

type ObjectShape = 'object' | 'non-object' | 'unknown';

/** Whether the importer certainly converts a schema to an object, certainly not, or unknown. */
function objectShape(schema: AnyNode): ObjectShape {
  if (!isPlainObject(schema) || isRefNode(schema)) {
    return 'unknown';
  }
  const types = schemaTypes(schema);
  if (
    schema.oneOf !== undefined ||
    schema.anyOf !== undefined ||
    schema.not !== undefined ||
    schema.discriminator !== undefined
  ) {
    return 'unknown';
  }
  const nonNullTypes = types.filter((type) => type !== 'null');
  const hasProperties = isPlainObject(schema.properties) && Object.keys(schema.properties).length > 0;
  if (types.includes('null')) {
    // A nullable body imports as `nullable<T>`, which is never inlined.
    return hasProperties && (nonNullTypes.length === 0 || nonNullTypes.includes('object')) ? 'non-object' : 'unknown';
  }
  const allOf = Array.isArray(schema.allOf)
    ? schema.allOf.filter(
        (member: AnyNode) => isRefNode(member) || (isPlainObject(member) && Object.keys(member).length > 0),
      )
    : [];
  if (hasProperties) {
    return nonNullTypes.length === 0 || nonNullTypes.includes('object') ? 'object' : 'unknown';
  }
  if (allOf.length > 0) {
    const allObjects = allOf.every(
      (member: AnyNode) => isRefNode(member) || member.type === 'object' || isPlainObject(member.properties),
    );
    return allOf.length >= 2 && allObjects ? 'object' : 'unknown';
  }
  if (nonNullTypes.length === 1 && ['array', 'string', 'number', 'integer', 'boolean'].includes(nonNullTypes[0]!)) {
    return 'non-object';
  }
  return 'unknown';
}

type BodyMode = { mode: 'inline'; schema: Located } | { mode: 'referenced' } | { mode: 'unknown' };

const COMPONENT_SCHEMA_POINTER = /#\/components\/schemas\/[^/]+$/;

/**
 * The body of a `stream-condition` operation: the importer dereferences the JSON body schema and
 * inlines it with the condition property added, whether or not the schema is shared.
 */
function streamConditionBodyMode(ctx: Ctx, schema: BodySchemaInfo): BodyMode {
  const target = isRefNode(schema.node)
    ? ctx.resolve(schema.node, schema.location.source.absoluteRef)
    : { node: schema.node, location: schema.location };
  if (target.node === undefined || target.location === undefined || isRefNode(target.node)) {
    return { mode: 'unknown' };
  }
  return objectShape(target.node) === 'object'
    ? {
        mode: 'inline',
        schema: { node: target.node, location: target.location },
      }
    : { mode: 'unknown' };
}

/** Whether a JSON/form body is inlined into the request wrapper or exposed as `body`. */
function bodyMode(ctx: Ctx, operation: OperationInfo, schema: BodySchemaInfo, facts: DocumentFacts): BodyMode {
  if (streamingMode(operation.node) === 'stream-condition') {
    return streamConditionBodyMode(ctx, schema);
  }
  if (!isRefNode(schema.node)) {
    const shape = objectShape(schema.node);
    if (shape === 'object') {
      return {
        mode: 'inline',
        schema: { node: schema.node, location: schema.location },
      };
    }
    return shape === 'non-object' ? { mode: 'referenced' } : { mode: 'unknown' };
  }
  const target = ctx.resolve(schema.node, schema.location.source.absoluteRef);
  if (target.node === undefined || target.location === undefined || isRefNode(target.node)) {
    return { mode: 'unknown' };
  }
  const shape = objectShape(target.node);
  if (shape === 'non-object') {
    return { mode: 'referenced' };
  }
  const targetPointer = target.location.absolutePointer;
  if (shape !== 'object' || !COMPONENT_SCHEMA_POINTER.test(targetPointer)) {
    return { mode: 'unknown' };
  }
  const requestUsers = facts.bodyRefUsers.get(targetPointer) ?? 0;
  const otherReferences = (facts.refsByTarget.get(targetPointer) ?? []).filter(
    (from) => !facts.bodyRefSources.has(from),
  );
  if (
    requestUsers >= 2 ||
    otherReferences.some((from) => from.includes('#/components/schemas/') || facts.responseRefSources.has(from))
  ) {
    return { mode: 'referenced' };
  }
  if (requestUsers === 1 && otherReferences.length === 0) {
    return {
      mode: 'inline',
      schema: { node: target.node, location: target.location },
    };
  }
  return { mode: 'unknown' };
}

interface BodyProperty {
  key: string;
  name: string;
  overridden: boolean;
  location: Location;
  via: string[];
}

interface CollectedBody {
  /** Properties the importer adds as direct (deconflicted) request properties. */
  direct: BodyProperty[];
  /** Wire keys of direct `readOnly` properties the importer drops from write requests. */
  droppedReadOnly: Set<string>;
  /** Properties inherited through `allOf` `$ref`s (`extends`), which are not deconflicted. */
  inherited: BodyProperty[];
  /** Every name a body property might get, for path parameter renames. */
  possibleNames: Set<string>;
}

function propertyOf(
  ctx: Ctx,
  key: string,
  schema: Located,
  via: string[],
): (BodyProperty & { readOnly: boolean }) | undefined {
  const raw = schema.node;
  if (isIgnored(raw)) {
    return undefined;
  }
  const resolved = resolveNode(ctx, raw, schema.location)?.node;
  const override = stringExtension(raw, 'x-fern-property-name');
  return {
    key,
    name: override ?? key,
    overridden: override !== undefined,
    location: schema.location,
    via,
    readOnly: (isPlainObject(raw) && raw.readOnly === true) || (isPlainObject(resolved) && resolved.readOnly === true),
  };
}

/** Adds every property name reachable from a schema to `names`, without judging certainty. */
function addPossibleNames(ctx: Ctx, schema: Located, names: Set<string>, seen: Set<string>): void {
  const resolved = resolveNode(ctx, schema.node, schema.location);
  if (resolved === undefined || !isPlainObject(resolved.node)) {
    return;
  }
  const pointer = resolved.location.absolutePointer;
  if (seen.has(pointer)) {
    return;
  }
  seen.add(pointer);
  const node = resolved.node;
  if (isPlainObject(node.properties)) {
    for (const [key, property] of Object.entries(node.properties)) {
      names.add(key);
      const override = stringExtension(property, 'x-fern-property-name');
      if (override !== undefined) {
        names.add(override);
      }
    }
  }
  for (const keyword of ['allOf', 'oneOf', 'anyOf']) {
    const members = node[keyword];
    if (Array.isArray(members)) {
      members.forEach((member, index) =>
        addPossibleNames(
          ctx,
          {
            node: member,
            location: resolved.location.child([keyword, index]),
          },
          names,
          seen,
        ),
      );
    }
  }
}

/** Properties a type declaration has, including everything it extends. */
function typeProperties(ctx: Ctx, schema: Located, via: string[], seen: Set<string>): BodyProperty[] | undefined {
  const resolved = resolveNode(ctx, schema.node, schema.location);
  if (resolved === undefined || !isPlainObject(resolved.node)) {
    return undefined;
  }
  const pointer = resolved.location.absolutePointer;
  if (seen.has(pointer)) {
    return [];
  }
  seen.add(pointer);
  const node = resolved.node;
  if (node.oneOf !== undefined || node.anyOf !== undefined || node.discriminator !== undefined) {
    return undefined;
  }
  const result: BodyProperty[] = [];
  if (isPlainObject(node.properties)) {
    for (const key of Object.keys(node.properties)) {
      const property = propertyOf(
        ctx,
        key,
        {
          node: node.properties[key],
          location: resolved.location.child(['properties', key]),
        },
        via,
      );
      if (property !== undefined) {
        result.push(property);
      }
    }
  }
  if (Array.isArray(node.allOf)) {
    for (const [index, member] of node.allOf.entries()) {
      const memberVia = isRefNode(member) ? [...via, refName(member.$ref)] : via;
      const properties = typeProperties(
        ctx,
        { node: member, location: resolved.location.child(['allOf', index]) },
        memberVia,
        seen,
      );
      if (properties === undefined) {
        return undefined;
      }
      result.push(...properties);
    }
  }
  return result;
}

function requiredKeys(ctx: Ctx, schema: Located): Set<string> {
  const result = new Set<string>();
  const visit = (current: Located): void => {
    const resolved = resolveNode(ctx, current.node, current.location);
    if (resolved === undefined || !isPlainObject(resolved.node)) {
      return;
    }
    if (Array.isArray(resolved.node.required)) {
      for (const key of resolved.node.required) {
        if (typeof key === 'string') {
          result.add(key);
        }
      }
    }
    if (Array.isArray(resolved.node.allOf)) {
      resolved.node.allOf.forEach((member: AnyNode, index: number) => {
        if (!isRefNode(member)) {
          visit({
            node: member,
            location: resolved.location.child(['allOf', index]),
          });
        }
      });
    }
  };
  visit(schema);
  return result;
}

/**
 * Collects the properties of an inlined request body: its own properties and those of inline
 * `allOf` members become direct request properties, `allOf` `$ref` members are inherited.
 */
function collectInlineBody(ctx: Ctx, schema: Located, isWrite: boolean): CollectedBody {
  const possibleNames = new Set<string>();
  addPossibleNames(ctx, schema, possibleNames, new Set());
  const direct: BodyProperty[] = [];
  const inlined: BodyProperty[] = [];
  const inherited: BodyProperty[] = [];
  const droppedReadOnly = new Set<string>();
  const uncertainKeys = new Set<string>();
  const node = schema.node;

  const addDirect = (target: BodyProperty[], current: Located): void => {
    const properties = current.node.properties;
    if (!isPlainObject(properties)) {
      return;
    }
    for (const key of Object.keys(properties)) {
      const property = propertyOf(
        ctx,
        key,
        {
          node: properties[key],
          location: current.location.child(['properties', key]),
        },
        [],
      );
      if (property === undefined) {
        continue;
      }
      if (isWrite && property.readOnly) {
        droppedReadOnly.add(key);
      } else {
        target.push(property);
      }
    }
  };

  /** Inline `allOf` members: their properties are merged; their own `$ref` parents are dropped. */
  const addInlineMember = (current: Located): void => {
    const member = current.node;
    if (!isPlainObject(member)) {
      return;
    }
    if (member.oneOf !== undefined || member.anyOf !== undefined) {
      markAllUncertain(current);
      return;
    }
    addDirect(inlined, current);
    if (Array.isArray(member.allOf)) {
      member.allOf.forEach((nested: AnyNode, index: number) => {
        const nestedLocation = current.location.child(['allOf', index]);
        if (isRefNode(nested)) {
          markAllUncertain({ node: nested, location: nestedLocation });
        } else {
          addInlineMember({ node: nested, location: nestedLocation });
        }
      });
    }
  };

  const markAllUncertain = (current: Located): void => {
    const names = new Set<string>();
    addPossibleNames(ctx, current, names, new Set());
    for (const name of names) {
      uncertainKeys.add(name);
    }
  };

  addDirect(direct, schema);

  const parents: { properties: BodyProperty[]; keys: Set<string> }[] = [];
  if (Array.isArray(node.allOf)) {
    node.allOf.forEach((member: AnyNode, index: number) => {
      const memberLocation = schema.location.child(['allOf', index]);
      if (isRefNode(member)) {
        const target = resolveNode(ctx, member, memberLocation)?.node;
        if (
          isPlainObject(target) &&
          isPlainObject(target.discriminator) &&
          target.discriminator.mapping !== undefined
        ) {
          return;
        }
        const properties = typeProperties(
          ctx,
          { node: member, location: memberLocation },
          [refName(member.$ref)],
          new Set(),
        );
        if (properties === undefined) {
          markAllUncertain({ node: member, location: memberLocation });
          return;
        }
        parents.push({
          properties,
          keys: new Set(properties.map((property) => property.key)),
        });
      } else {
        addInlineMember({ node: member, location: memberLocation });
      }
    });
  }

  // Parents sharing a property key are inlined by the importer instead of extended.
  const keyOwners = new Map<string, number>();
  for (const parent of parents) {
    for (const key of parent.keys) {
      keyOwners.set(key, (keyOwners.get(key) ?? 0) + 1);
    }
  }
  const directKeys = new Set([...direct, ...inlined].map((property) => property.key));
  const required = requiredKeys(ctx, schema);
  for (const parent of parents) {
    if ([...parent.keys].some((key) => (keyOwners.get(key) ?? 0) > 1)) {
      for (const key of parent.keys) {
        uncertainKeys.add(key);
      }
      continue;
    }
    for (const property of parent.properties) {
      // Redeclared or re-required keys are merged with the parent's property by the importer.
      if (directKeys.has(property.key) || required.has(property.key)) {
        uncertainKeys.add(property.key);
        continue;
      }
      inherited.push(property);
    }
  }

  const certain = (property: BodyProperty) => !uncertainKeys.has(property.key);
  return {
    direct: [...direct, ...inlined].filter(certain),
    inherited: inherited.filter(certain),
    droppedReadOnly,
    possibleNames,
  };
}

function collectMultipartBody(ctx: Ctx, schema: Located): { properties: BodyProperty[]; possibleNames: Set<string> } {
  const possibleNames = new Set<string>();
  addPossibleNames(ctx, schema, possibleNames, new Set());
  const resolved = resolveNode(ctx, schema.node, schema.location);
  const properties: BodyProperty[] = [];
  if (
    resolved !== undefined &&
    isPlainObject(resolved.node) &&
    isPlainObject(resolved.node.properties) &&
    !schemaTypes(resolved.node).includes('null')
  ) {
    for (const key of Object.keys(resolved.node.properties)) {
      const raw = resolved.node.properties[key];
      if (isIgnored(raw)) {
        continue;
      }
      properties.push({
        key,
        name: key,
        overridden: false,
        location: resolved.location.child(['properties', key]),
        via: [],
      });
    }
  }
  return { properties, possibleNames };
}

/** Collects the whole-document facts. `refs` are the `$ref` occurrences seen while walking. */
export function documentFacts(ctx: Ctx, root: Located, refs: RefOccurrence[]): DocumentFacts {
  const operations = fernOperations(ctx, root);
  const authHeaders = securitySchemeHeaders(ctx, root);

  const globalHeaders = new Set(declaredGlobalHeaders(root.node));
  const headerCounts = new Map<string, number>();
  for (const operation of operations) {
    for (const parameter of liveParameters(operation.allParameters)) {
      if (isImportedHeader(parameter, authHeaders) && parameter.name.toLowerCase() !== 'authorization') {
        headerCounts.set(parameter.name, (headerCounts.get(parameter.name) ?? 0) + 1);
      }
    }
  }
  for (const [name, count] of headerCounts) {
    if (count >= operations.length * GLOBAL_HEADER_THRESHOLD) {
      globalHeaders.add(name);
    }
  }

  const refsByTarget = new Map<string, string[]>();
  for (const { from, to } of refs) {
    const list = refsByTarget.get(to) ?? [];
    if (!list.includes(from)) {
      list.push(from);
    }
    refsByTarget.set(to, list);
  }

  const bodyRefUsers = new Map<string, number>();
  const bodyRefSources = new Set<string>();
  for (const operation of operations) {
    const { schema } = requestBodyKind(ctx, operation);
    if (schema === undefined || !isRefNode(schema.node)) {
      continue;
    }
    const target = ctx.resolve(schema.node, schema.location.source.absoluteRef);
    if (target.location === undefined) {
      continue;
    }
    bodyRefSources.add(schema.location.absolutePointer);
    if (streamingMode(operation.node) === 'stream-condition') {
      // The importer dereferences these bodies, so they do not count as uses of the schema.
      continue;
    }
    const pointer = target.location.absolutePointer;
    bodyRefUsers.set(pointer, (bodyRefUsers.get(pointer) ?? 0) + 1);
  }

  const responseRefSources = new Set<string>();
  for (const operation of operations) {
    const schema = getJsonResponseSchema(ctx, operation);
    if (schema !== undefined && isRefNode(schema.node)) {
      responseRefSources.add(schema.location.absolutePointer);
    }
  }

  return {
    operations,
    authHeaders,
    globalHeaders,
    refsByTarget,
    bodyRefUsers,
    bodyRefSources,
    responseRefSources,
  };
}

export interface RequestWrapper {
  items: WrapperItem[];
  /**
   * The names a JSON or form request body takes in the wrapper (its inlined properties, or
   * `body`), when the importer's choice can be decided; undefined otherwise.
   */
  bodyNames: Set<string> | undefined;
  /** Wire keys of `readOnly` properties the importer drops from an inlined request body. */
  droppedReadOnlyKeys: Set<string>;
  /** Path parameters with their SDK name (after automatic renames), when certain. */
  pathParameterNames: { parameter: ParameterInfo; name: string | undefined }[];
}

function isLiteralHeader(parameter: ParameterInfo): boolean {
  const schema = parameter.node.schema;
  return isPlainObject(schema) && !isRefNode(schema) && typeof schema.default === 'string' && schema.default.length > 0;
}

/** Builds the request wrapper of one operation. */
export function buildRequestWrapper(ctx: Ctx, operation: OperationInfo, facts: DocumentFacts): RequestWrapper {
  const parameters = liveParameters(operation.parameters);
  const allParameters = liveParameters(operation.allParameters);
  const pathParameters = parameters.filter((parameter) => parameter.in === 'path');
  const queryParameters = parameters.filter((parameter) => parameter.in === 'query');
  const importedHeaders = parameters.filter((parameter) => isImportedHeader(parameter, facts.authHeaders));
  const endpointHeaders = importedHeaders.filter((parameter) => !facts.globalHeaders.has(parameter.name));

  let bodyNames: Set<string> | undefined;
  let droppedReadOnlyKeys = new Set<string>();
  const body = requestBodyKind(ctx, operation);
  if (body.kind === 'none') {
    bodyNames = new Set();
  }
  let headersInWrapper = body.kind !== 'octet' && body.kind !== 'unknown';
  let referencedBody = false;
  let possibleBodyNames = new Set<string>();
  let directProperties: BodyProperty[] = [];
  let inheritedProperties: BodyProperty[] = [];
  let multipartProperties: BodyProperty[] = [];

  if (body.kind === 'unknown') {
    possibleBodyNames.add('body');
    const requestBody = getRequestBody(ctx, operation);
    const content = requestBody === undefined ? undefined : resolveChild(ctx, requestBody, 'content');
    if (content !== undefined && isPlainObject(content.node)) {
      for (const mediaType of Object.keys(content.node)) {
        const mediaTypeObject = resolveChild(ctx, content, mediaType);
        if (mediaTypeObject !== undefined && isPlainObject(mediaTypeObject.node)) {
          addPossibleNames(
            ctx,
            {
              node: mediaTypeObject.node.schema,
              location: mediaTypeObject.location.child('schema'),
            },
            possibleBodyNames,
            new Set(),
          );
        }
      }
    }
  } else if (body.kind === 'octet') {
    referencedBody = queryParameters.length > 0;
  } else if (body.kind === 'multipart') {
    const collected = collectMultipartBody(ctx, body.schema!);
    multipartProperties = collected.properties;
    possibleBodyNames = collected.possibleNames;
  } else if (body.kind === 'json' || body.kind === 'form') {
    const mode = bodyMode(ctx, operation, body.schema!, facts);
    if (mode.mode === 'referenced') {
      possibleBodyNames.add('body');
      bodyNames = new Set(['body']);
      referencedBody =
        pathParameters.length > 0 ||
        queryParameters.length > 0 ||
        endpointHeaders.some((parameter) => !isLiteralHeader(parameter));
    } else if (mode.mode === 'inline') {
      const collected = collectInlineBody(ctx, mode.schema, WRITE_METHODS.has(operation.method));
      directProperties = collected.direct;
      inheritedProperties = collected.inherited;
      possibleBodyNames = collected.possibleNames;
      bodyNames = collected.possibleNames;
      droppedReadOnlyKeys = collected.droppedReadOnly;
    } else {
      possibleBodyNames.add('body');
      addPossibleNames(ctx, { node: body.schema!.node, location: body.schema!.location }, possibleBodyNames, new Set());
    }
  }
  if (body.kind === 'unknown') {
    headersInWrapper = false;
  }

  // Names a path parameter is automatically renamed away from.
  const reserved = new Set<string>(possibleBodyNames);
  for (const parameter of allParameters) {
    if (parameter.in === 'query') {
      reserved.add(parameter.name);
    } else if (parameter.in === 'header') {
      reserved.add(stringExtension(parameter.node, 'x-fern-parameter-name') ?? parameter.name);
    }
  }

  const items: WrapperItem[] = [];
  const pathParameterNames: RequestWrapper['pathParameterNames'] = [];

  if (referencedBody) {
    items.push({
      kind: 'request-body',
      name: 'body',
      openapiName: 'requestBody',
      location: operation.location.child('requestBody'),
    });
  }

  for (const parameter of pathParameters) {
    const override = stringExtension(parameter.node, 'x-fern-parameter-name');
    const renamed = override === undefined && reserved.has(parameter.name);
    const name = renamed ? undefined : (override ?? parameter.name);
    pathParameterNames.push({ parameter, name });
    if (name === undefined || parameter.node['x-fern-sdk-variable'] !== undefined) {
      continue;
    }
    items.push({
      kind: 'path',
      name,
      openapiName: parameter.name,
      override: override === undefined ? undefined : 'x-fern-parameter-name',
      parameter,
      location: parameter.location,
    });
  }

  const headerNames = new Set<string>();
  for (const parameter of importedHeaders) {
    headerNames.add(headerSdkName(parameter.name, stringExtension(parameter.node, 'x-fern-parameter-name')));
  }
  if (headersInWrapper) {
    for (const parameter of endpointHeaders) {
      const override = stringExtension(parameter.node, 'x-fern-parameter-name');
      items.push({
        kind: 'header',
        name: headerSdkName(parameter.name, override),
        openapiName: parameter.name,
        override: override === undefined ? undefined : 'x-fern-parameter-name',
        parameter,
        location: parameter.location,
      });
    }
  }

  for (const parameter of queryParameters) {
    const override = stringExtension(parameter.node, 'x-fern-parameter-name');
    items.push({
      kind: 'query',
      name: override ?? parameter.name,
      openapiName: parameter.name,
      override: override === undefined ? undefined : 'x-fern-parameter-name',
      parameter,
      location: parameter.location,
    });
  }

  // Direct body properties are renamed when their name is already used by a query parameter
  // (raw `name`), a header (SDK name), or an earlier body property.
  const usedNames = new Set<string>([...queryParameters.map((parameter) => parameter.name), ...headerNames]);
  for (const property of directProperties) {
    const renamed = usedNames.has(property.name);
    usedNames.add(property.name);
    if (renamed) {
      continue;
    }
    items.push({
      kind: 'body-property',
      name: property.name,
      openapiName: property.key,
      override: property.overridden ? 'x-fern-property-name' : undefined,
      location: property.location,
    });
  }
  for (const property of inheritedProperties) {
    items.push({
      kind: 'inherited-property',
      name: property.name,
      openapiName: property.key,
      override: property.overridden ? 'x-fern-property-name' : undefined,
      via: property.via,
      location: property.location,
    });
  }
  for (const property of multipartProperties) {
    items.push({
      kind: 'multipart-property',
      name: property.name,
      openapiName: property.key,
      location: property.location,
    });
  }

  return { items, bodyNames, droppedReadOnlyKeys, pathParameterNames };
}
