/**
 * A small, defensive OpenAPI resolver for the docs surface.
 *
 * It reads the fields the docs need (path/verb, parameters, bounded recursive
 * request/response schemas, schema titles, and oneOf/anyOf variants) straight from the
 * overlaid spec, so the docs build stays pure Node with no @cloudflare/forge
 * runtime dependency. Local component references are followed defensively;
 * cycles and unusually deep schema graphs stop expanding rather than failing
 * the build.
 */
import { z } from 'astro/zod';
import type {
  OperationResponse,
  RequestBody,
  RequestRepresentation,
  ResponseExample,
  ResponseRepresentation,
  SchemaNode,
  EnumValueMetadata,
} from './model.ts';
import { isJsonMediaType } from './request-body.ts';
import { classifyResponseStatus } from './response.ts';
import {
  type ExampleSchema,
  type MediaTypeSchema,
  type OpenApiDocumentSchema,
  type OpenApiSchema,
  type OperationSchema,
  type ParameterSchema,
  type PathItemSchema,
  type StructuredOpenApiSchema,
  fernSdkCodeSampleNameParserSchema,
} from './openapi.ts';
import {
  jsonValueSchema,
  type JsonValueSchema,
  type OperationCodeSampleSchema,
  type OperationExampleSchema,
} from './schema.ts';

//#region Minimal spec shapes (only what we read)

export type {
  ExampleSchema,
  MediaTypeSchema,
  OpenApiDocumentSchema,
  OpenApiSchema,
  OperationSchema,
  ParameterSchema,
  PathItemSchema,
  RequestBodySchema,
  ResponseSchema,
} from './openapi.ts';

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface ResolvedOperation {
  method: HttpMethod;
  path: string;
  description: string;
  pathParams: SchemaNode[];
  queryParams: SchemaNode[];
  requestBody: RequestBody | null;
  responses: OperationResponse[];
  examples: OperationExampleSchema[];
}

//#endregion

//#region $ref helpers

function refName(ref: string): string {
  return ref.split('/').pop() ?? ref;
}

const MAX_REF_DEPTH = 6;

type ComponentSection = 'schemas' | 'parameters' | 'requestBodies' | 'responses' | 'examples';

function componentRefName(ref: string, section: ComponentSection): string | undefined {
  const prefix = `#/components/${section}/`;
  if (!ref.startsWith(prefix)) return undefined;
  const token = ref.slice(prefix.length);
  if (!token || token.includes('/')) return undefined;
  try {
    const decoded = decodeURIComponent(token);
    if (decoded.includes('/')) return undefined;
    return decoded.replace(/~1/g, '/').replace(/~0/g, '~');
  } catch {
    return undefined;
  }
}

function resolveComponent<T extends { $ref?: string | undefined }>(
  value: T | undefined,
  components: Record<string, T | undefined> | undefined,
  section: ComponentSection,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): T | undefined {
  if (!value?.$ref) return value;
  const name = componentRefName(value.$ref, section);
  if (!name) return undefined;
  if (depth >= MAX_REF_DEPTH || seen.has(name)) return undefined;
  return resolveComponent(components?.[name], components, section, depth + 1, new Set([...seen, name]));
}

function structuredSchema(schema: OpenApiSchema | undefined): StructuredOpenApiSchema | undefined {
  return typeof schema === 'boolean' ? undefined : schema;
}

function resolveSchema(
  doc: OpenApiDocumentSchema,
  schema: OpenApiSchema | undefined,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): OpenApiSchema | undefined {
  const current = structuredSchema(schema);
  if (!current?.$ref) return schema;
  const name = componentRefName(current.$ref, 'schemas');
  if (!name || depth >= MAX_REF_DEPTH || seen.has(name)) return undefined;
  return resolveSchema(doc, doc.components?.schemas?.[name], depth + 1, new Set([...seen, name]));
}

function isSchemaIgnored(
  doc: OpenApiDocumentSchema,
  schema: OpenApiSchema | undefined,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): boolean {
  const current = structuredSchema(schema);
  if (!current) return false;
  if (current['x-fern-ignore'] === true) return true;
  if (!current.$ref) return false;
  const name = componentRefName(current.$ref, 'schemas');
  if (!name || depth >= MAX_REF_DEPTH || seen.has(name)) return false;
  return isSchemaIgnored(doc, doc.components?.schemas?.[name], depth + 1, new Set([...seen, name]));
}

function schemaLayers(
  doc: OpenApiDocumentSchema,
  schema: OpenApiSchema | undefined,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): StructuredOpenApiSchema[] {
  const current = structuredSchema(schema);
  if (!current) return [];
  if (!current.$ref) return [current];
  const name = componentRefName(current.$ref, 'schemas');
  if (!name || depth >= MAX_REF_DEPTH || seen.has(name)) return [current];
  return [...schemaLayers(doc, doc.components?.schemas?.[name], depth + 1, new Set([...seen, name])), current];
}

function resolveParam(doc: OpenApiDocumentSchema, p: ParameterSchema | undefined): ParameterSchema | undefined {
  return resolveComponent(p, doc.components?.parameters, 'parameters');
}

function isParameterIgnored(
  doc: OpenApiDocumentSchema,
  parameter: ParameterSchema | undefined,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): boolean {
  if (!parameter) return false;
  if (parameter['x-fern-ignore'] === true) return true;
  if (!parameter.$ref) return false;
  const name = componentRefName(parameter.$ref, 'parameters');
  if (!name || depth >= MAX_REF_DEPTH || seen.has(name)) return false;
  return isParameterIgnored(doc, doc.components?.parameters?.[name], depth + 1, new Set([...seen, name]));
}

function schemaTypeName(doc: OpenApiDocumentSchema, schema: OpenApiSchema | undefined): string {
  const current = structuredSchema(schema);
  if (!current) return 'unknown';
  if (current.$ref) {
    // Resolve local aliases so primitive refs (e.g. `dns-records_identifier` → string)
    // surface as the primitive rather than the internal schema name.
    const resolved = structuredSchema(resolveSchema(doc, current));
    const types = schemaTypes(resolved?.type);
    const scalar = types.find((type) => type !== 'object' && type !== 'array' && type !== 'null');
    if (scalar) return scalar === 'integer' ? 'number' : scalar;
    if (types.includes('array')) return `${schemaTypeName(doc, resolved?.items)}[]`;
    return refName(current.$ref);
  }
  const types = schemaTypes(current.type);
  if (types.includes('integer')) return 'number';
  if (types.includes('array')) return current.items ? `${schemaTypeName(doc, current.items)}[]` : 'array';
  const scalar = types.find((type) => type !== 'null');
  if (scalar) return scalar;
  // Many spec schemas omit an explicit `type`. Recover it from other signals so
  // the field shows something real instead of "unknown":
  const union = current.oneOf ?? current.anyOf;
  if (union && union.length > 0) return unionLabel(doc, union);
  if (current.enum && current.enum.length > 0) {
    const t = typeof current.enum[0];
    if (t === 'number' || t === 'boolean' || t === 'string') return t; // enum values imply the scalar type
  }
  if (current.properties || current.allOf) return 'object';
  return 'unknown';
}

function schemaTypes(value: StructuredOpenApiSchema['type']): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * A concise display label for an inline `oneOf`/`anyOf` (one with no `$ref`
 * name of its own): the distinct variant type names joined when there are only
 * a few, otherwise "one of N". Named unions keep their schema name via the
 * `$ref` branch above; this only covers anonymous inline unions, which would
 * otherwise fall through to "unknown".
 */
function unionLabel(doc: OpenApiDocumentSchema, union: OpenApiSchema[]): string {
  const names = Array.from(new Set(union.map((v) => schemaTypeName(doc, v)))).filter((n) => n !== 'unknown');
  const joined = names.join(' | ');
  if (names.length > 0 && names.length <= 3 && joined.length <= 40) return joined;
  return `one of ${union.length}`;
}

const displayScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

function scalarEnum(values: unknown[] | undefined): Array<string | number | boolean> | undefined {
  if (!values) return undefined;
  const out = values.flatMap((value) => {
    const parsed = displayScalarSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
  return out.length > 0 ? out : undefined;
}

function scalarEnumUnion(union: OpenApiSchema[]): Array<string | number | boolean> | undefined {
  const values: Array<string | number | boolean> = [];
  for (const variant of union) {
    const current = structuredSchema(variant);
    if (!current) return undefined;
    // Keep named or documented variants expanded: their identity carries more
    // meaning than their literal values alone.
    if (
      current.$ref ||
      current.title ||
      current.description ||
      current.deprecated ||
      current.default !== undefined ||
      current.items ||
      current.properties ||
      current.allOf ||
      current.oneOf ||
      current.anyOf
    )
      return undefined;
    const variantValues = scalarEnum(current.enum);
    if (!variantValues) return undefined;
    values.push(...variantValues);
  }
  return [...new Set(values)];
}

function scalarDefault(value: unknown): string | number | boolean | undefined {
  const parsed = displayScalarSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function enumValueMetadata(
  values: Array<string | number | boolean>,
  schemas: Array<StructuredOpenApiSchema | undefined>,
): EnumValueMetadata[] | undefined {
  const metadata = new Map<string, { description?: string; deprecated?: boolean }>();
  for (const schema of schemas) {
    for (const [value, entry] of Object.entries(schema?.['x-fern-enum'] ?? {})) {
      const description = entry.description?.trim();
      if (description || entry.deprecated === true) {
        metadata.set(value, {
          ...(description ? { description } : {}),
          ...(entry.deprecated === true ? { deprecated: true } : {}),
        });
      }
    }
  }
  const result = values.flatMap<EnumValueMetadata>((value) => {
    const entry = metadata.get(String(value));
    return entry ? [{ value, ...entry }] : [];
  });
  return result.length > 0 ? result : undefined;
}

interface GatheredObjectSchema {
  schema: StructuredOpenApiSchema;
  ignoredProperties: Set<string>;
}

/** Merge a (possibly $ref'd, possibly allOf) object schema into a flat property map. */
function gatherObjectSchemaResult(
  doc: OpenApiDocumentSchema,
  schema: OpenApiSchema | undefined,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): GatheredObjectSchema | undefined {
  if (isSchemaIgnored(doc, schema)) return undefined;
  const current = structuredSchema(schema);
  const base = structuredSchema(resolveSchema(doc, current));
  if (!base) return undefined;
  if (!base.properties && !base.allOf && !schemaTypes(base.type).includes('object')) {
    return { schema: base, ignoredProperties: new Set() };
  }
  const refKey = current?.$ref ? refName(current.$ref) : undefined;
  if (depth >= MAX_REF_DEPTH || (refKey !== undefined && seen.has(refKey))) {
    return { schema: base, ignoredProperties: new Set() };
  }
  const nextSeen = refKey === undefined ? seen : new Set([...seen, refKey]);
  const properties: Record<string, OpenApiSchema> = {};
  const ignoredProperties = new Set<string>();
  for (const [name, property] of Object.entries(base.properties ?? {})) {
    if (!property) continue;
    if (isSchemaIgnored(doc, property)) ignoredProperties.add(name);
    else properties[name] = property;
  }
  const required: string[] = [...(base.required ?? [])];
  for (const sub of base.allOf ?? []) {
    const gathered = gatherObjectSchemaResult(doc, sub, depth + 1, nextSeen);
    if (!gathered) continue;
    for (const name of gathered.ignoredProperties) {
      ignoredProperties.add(name);
      delete properties[name];
    }
    for (const [name, property] of Object.entries(gathered.schema.properties ?? {})) {
      if (property && !ignoredProperties.has(name)) properties[name] = property;
    }
    if (gathered.schema.required) required.push(...gathered.schema.required);
  }
  for (const name of ignoredProperties) delete properties[name];
  return {
    schema: {
      type: 'object',
      properties,
      required: [...new Set(required)].filter((name) => !ignoredProperties.has(name)),
    },
    ignoredProperties,
  };
}

function gatherObjectSchema(
  doc: OpenApiDocumentSchema,
  schema: OpenApiSchema | undefined,
): StructuredOpenApiSchema | undefined {
  return gatherObjectSchemaResult(doc, schema)?.schema;
}

//#endregion

//#region Schema tree

/** Cap recursion so cyclic/very deep schemas can't blow up the build. */
const MAX_DEPTH = 6;

interface BuildCtx {
  name?: string;
  sdkName?: string;
  required: boolean;
  depth: number;
  /** $ref names already on this path — used to break cycles. */
  seen: ReadonlySet<string>;
  /** Param-level description override (takes precedence over the schema's). */
  description?: string;
}

/** Build a (bounded, cycle-safe) schema tree node. */
function buildSchemaNode(
  doc: OpenApiDocumentSchema,
  schema: OpenApiSchema | undefined,
  ctx: BuildCtx,
): SchemaNode | null {
  if (isSchemaIgnored(doc, schema)) return null;
  const node: SchemaNode = { type: schemaTypeName(doc, schema), required: ctx.required };
  if (ctx.name !== undefined) node.name = ctx.name;
  if (ctx.sdkName !== undefined) node.sdkName = ctx.sdkName;

  const current = structuredSchema(schema);
  const refKey = current?.$ref ? refName(current.$ref) : undefined;
  const resolved = structuredSchema(resolveSchema(doc, current));
  const title = current?.title ?? resolved?.title;
  if (title?.trim()) node.title = title.trim();
  const format = current?.format ?? resolved?.format;
  if (format) node.format = format;

  const description = ctx.description ?? current?.description ?? resolved?.description;
  if (description?.trim()) node.description = description.trim();
  const en = scalarEnum(resolved?.enum ?? current?.enum);
  if (en) {
    node.enumValues = en;
    const metadata = enumValueMetadata(en, schemaLayers(doc, current));
    if (metadata) node.enumValueMetadata = metadata;
  }
  const def = scalarDefault(resolved?.default ?? current?.default);
  if (def !== undefined) node.default = def;
  if (resolved?.deprecated === true || current?.deprecated === true) node.deprecated = true;

  // Stop expanding on a cycle (this $ref is already on the path) or the depth cap.
  if ((refKey !== undefined && ctx.seen.has(refKey)) || ctx.depth >= MAX_DEPTH) return node;
  const seen: ReadonlySet<string> = refKey !== undefined ? new Set([...ctx.seen, refKey]) : ctx.seen;
  const descend = (s: OpenApiSchema | undefined, extra: Partial<BuildCtx>): SchemaNode | null =>
    buildSchemaNode(doc, s, { required: false, depth: ctx.depth + 1, seen, ...extra });

  const union = resolved?.oneOf ?? resolved?.anyOf;
  if (union && union.length > 0) {
    const visibleUnion = union.filter((variant) => !isSchemaIgnored(doc, variant));
    const unionEnum = scalarEnumUnion(visibleUnion);
    if (unionEnum) {
      node.enumValues = unionEnum;
      const metadata = enumValueMetadata(unionEnum, [
        ...visibleUnion.flatMap((variant) => schemaLayers(doc, variant)),
        ...schemaLayers(doc, current),
      ]);
      if (metadata) node.enumValueMetadata = metadata;
      return node;
    }
    const variants = union.flatMap((variant) => {
      const resolved = descend(variant, {});
      return resolved ? [resolved] : [];
    });
    if (variants.length > 0) node.variants = variants;
    return node;
  }

  if (schemaTypes(resolved?.type).includes('array') && resolved?.items) {
    const items = descend(resolved.items, {});
    if (items) node.items = items;
    return node;
  }

  const merged = gatherObjectSchema(doc, schema);
  const props = merged?.properties;
  if (props) {
    const required = new Set(merged?.required ?? []);
    const children: SchemaNode[] = [];
    for (const [propName, propSchema] of Object.entries(props)) {
      if (!propSchema) continue;
      const sdkName = structuredSchema(propSchema)?.['x-fern-property-name']?.trim();
      const child = descend(propSchema, {
        name: propName,
        required: required.has(propName),
        ...(sdkName ? { sdkName } : {}),
      });
      if (child) children.push(child);
    }
    if (children.length > 0) node.children = children;
  }
  return node;
}

function extractParamNodes(
  doc: OpenApiDocumentSchema,
  params: ParameterSchema[],
  where: 'path' | 'query',
): SchemaNode[] {
  const out: SchemaNode[] = [];
  for (const raw of params) {
    const p = resolveParam(doc, raw);
    if (!p?.name || p.in !== where || isParameterIgnored(doc, raw)) continue;
    const node = buildSchemaNode(doc, p.schema, {
      name: p.name,
      required: p.required ?? false,
      depth: 0,
      seen: new Set(),
      ...(p.description ? { description: p.description } : {}),
    });
    if (node) out.push(node);
  }
  return out;
}

function effectiveParameters(
  doc: OpenApiDocumentSchema,
  pathParameters: ParameterSchema[],
  operationParameters: ParameterSchema[],
): ParameterSchema[] {
  const effective = new Map<string, ParameterSchema>();
  const apply = (raw: ParameterSchema): void => {
    const parameter = resolveParam(doc, raw);
    if (!parameter?.name || !parameter.in) return;
    const key = `${parameter.in}\0${parameter.name}`;
    if (isParameterIgnored(doc, raw)) effective.delete(key);
    else effective.set(key, raw);
  };
  pathParameters.forEach(apply);
  operationParameters.forEach(apply);
  return [...effective.values()];
}

function extractRequestBody(doc: OpenApiDocumentSchema, op: OperationSchema): RequestBody | null {
  if (!op.requestBody) return null;
  const requestBody = resolveComponent(op.requestBody, doc.components?.requestBodies, 'requestBodies');
  if (!requestBody) return { required: false, representations: [] };

  const required = requestBody.required === true;
  const representations = Object.entries(requestBody.content ?? {}).flatMap<RequestRepresentation>(
    ([rawMediaType, media]) => {
      const mediaType = rawMediaType.trim();
      // Empty keys are not valid OpenAPI media types; retain any valid sibling representations.
      if (!mediaType) return [];
      const schema = media?.schema;
      if (!schema) return [{ mediaType, schema: null }];
      const node = buildSchemaNode(doc, schema, { required, depth: 0, seen: new Set() });
      // Tag top-level fields with their API path so request samples can nest values.
      if (node?.children) for (const child of node.children) if (child.name) child.apiFieldPath = [child.name];
      return [{ mediaType, schema: node }];
    },
  );
  const description = requestBody.description?.trim() || undefined;
  return { required, ...(description ? { description } : {}), representations };
}

const MAX_EXAMPLE_DEPTH = 6;
const MAX_EXAMPLE_NODES = 200;
const MAX_EXAMPLE_PROPERTIES = 100;

function isJsonValue(value: unknown): value is JsonValueSchema {
  return jsonValueSchema.safeParse(value).success;
}

function schemaHint(schema: OpenApiSchema | undefined): JsonValueSchema | undefined {
  const current = structuredSchema(schema);
  if (!current) return undefined;
  if (Object.hasOwn(current, 'example') && isJsonValue(current.example)) return current.example;
  if (current.examples) {
    for (const example of current.examples) if (isJsonValue(example)) return example;
  }
  if (Object.hasOwn(current, 'default') && isJsonValue(current.default)) return current.default;
  if (current.enum) {
    for (const value of current.enum) if (isJsonValue(value)) return value;
  }
  return undefined;
}

function boundedExampleValue(
  value: JsonValueSchema,
  depth: number,
  budget: { remaining: number },
): JsonValueSchema | undefined {
  if (budget.remaining <= 0) return undefined;
  budget.remaining -= 1;
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_EXAMPLE_DEPTH) return Array.isArray(value) ? [] : {};
  if (Array.isArray(value)) {
    const out: JsonValueSchema[] = [];
    for (const item of value) {
      const bounded = boundedExampleValue(item, depth + 1, budget);
      if (bounded === undefined) break;
      out.push(bounded);
    }
    return out;
  }
  const out: Record<string, JsonValueSchema> = {};
  for (const [name, item] of Object.entries(value).slice(0, MAX_EXAMPLE_PROPERTIES)) {
    const bounded = boundedExampleValue(item, depth + 1, budget);
    if (bounded === undefined) break;
    out[name] = bounded;
  }
  return out;
}

function pruneIgnoredExampleFields(
  doc: OpenApiDocumentSchema,
  schema: OpenApiSchema | undefined,
  value: JsonValueSchema,
  depth = 0,
): JsonValueSchema | undefined {
  if (isSchemaIgnored(doc, schema)) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_EXAMPLE_DEPTH) return value;
  const resolved = structuredSchema(resolveSchema(doc, schema)) ?? structuredSchema(schema);
  const union = resolved?.oneOf ?? resolved?.anyOf;
  if (union?.length) {
    const ignoredProperties = new Set(
      union.flatMap((variant) => [...(gatherObjectSchemaResult(doc, variant)?.ignoredProperties ?? [])]),
    );
    const unionValue = Array.isArray(value)
      ? value
      : Object.fromEntries(Object.entries(value).filter(([name]) => !ignoredProperties.has(name)));
    const candidates = union.flatMap((variant) => {
      const candidate = pruneIgnoredExampleFields(doc, variant, unionValue, depth + 1);
      return candidate === undefined ? [] : [candidate];
    });
    return candidates.sort((left, right) => {
      const size = (candidate: JsonValueSchema): number =>
        candidate !== null && typeof candidate === 'object' ? Object.keys(candidate).length : 0;
      return size(right) - size(left);
    })[0];
  }
  if (Array.isArray(value)) {
    if (!resolved?.items) return value;
    return value.flatMap((item) => {
      const pruned = pruneIgnoredExampleFields(doc, resolved.items, item, depth + 1);
      return pruned === undefined ? [] : [pruned];
    });
  }
  const gathered = gatherObjectSchemaResult(doc, schema);
  if (!gathered) return value;
  const result: Record<string, JsonValueSchema> = {};
  for (const [name, item] of Object.entries(value)) {
    if (gathered.ignoredProperties.has(name)) continue;
    const property = gathered.schema.properties?.[name];
    if (!property) {
      result[name] = item;
      continue;
    }
    const pruned = pruneIgnoredExampleFields(doc, property, item, depth + 1);
    if (pruned !== undefined) result[name] = pruned;
  }
  return result;
}

function primitiveExample(schema: StructuredOpenApiSchema, name: string | undefined): JsonValueSchema | undefined {
  const types = schemaTypes(schema.type);
  if (types.includes('string')) return name || 'string';
  if (types.includes('integer') || types.includes('number')) {
    return schema.minimum ?? 0;
  }
  if (types.includes('boolean')) return true;
  if (types.includes('null') || schema.nullable === true) return null;
  return undefined;
}

function schemaExample(
  doc: OpenApiDocumentSchema,
  schema: OpenApiSchema | undefined,
  name?: string,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
  budget = { remaining: MAX_EXAMPLE_NODES },
): JsonValueSchema | undefined {
  if (isSchemaIgnored(doc, schema)) return undefined;
  const current = structuredSchema(schema);
  if (!current || budget.remaining <= 0) return undefined;
  budget.remaining -= 1;
  const resolved = structuredSchema(resolveSchema(doc, current)) ?? current;
  const localHint = schemaHint(current);
  const hint = localHint !== undefined ? localHint : current === resolved ? undefined : schemaHint(resolved);
  const items = resolved.items ?? current.items;
  const hasObjectShape =
    resolved.properties !== undefined ||
    resolved.allOf !== undefined ||
    current.properties !== undefined ||
    current.allOf !== undefined;
  if (hint !== undefined) {
    const pruned = pruneIgnoredExampleFields(doc, current, hint, depth);
    return pruned === undefined ? undefined : boundedExampleValue(pruned, depth, budget);
  }

  const refKey = current.$ref ? refName(current.$ref) : undefined;
  if (depth >= MAX_EXAMPLE_DEPTH || (refKey !== undefined && seen.has(refKey))) {
    return primitiveExample(resolved, name) ?? (hasObjectShape ? {} : items ? [] : undefined);
  }
  const nextSeen = refKey === undefined ? seen : new Set([...seen, refKey]);

  const union = resolved.oneOf ?? resolved.anyOf;
  if (union) {
    for (const variant of union) {
      if (isSchemaIgnored(doc, variant)) continue;
      const value = schemaExample(doc, variant, name, depth + 1, nextSeen, budget);
      if (value !== undefined) return value;
    }
  }

  if (schemaTypes(resolved.type).includes('array') || items) {
    const value = schemaExample(doc, items, name, depth + 1, nextSeen, budget);
    return value === undefined ? [] : [value];
  }

  const object = gatherObjectSchema(doc, current);
  if (object?.properties) {
    const required = new Set(object.required ?? []);
    const properties = Object.entries(object.properties)
      .filter((entry): entry is [string, OpenApiSchema] => entry[1] !== undefined)
      .sort(([left], [right]) => Number(required.has(right)) - Number(required.has(left)))
      .slice(0, MAX_EXAMPLE_PROPERTIES);
    const value: Record<string, JsonValueSchema> = {};
    for (const [propertyName, propertySchema] of properties) {
      if (isSchemaIgnored(doc, propertySchema)) continue;
      const propertyValue = schemaExample(doc, propertySchema, propertyName, depth + 1, nextSeen, budget);
      if (propertyValue !== undefined) value[propertyName] = propertyValue;
    }
    return value;
  }

  return primitiveExample(resolved, name);
}

function normalizeExample(
  doc: OpenApiDocumentSchema,
  name: string | undefined,
  raw: ExampleSchema | undefined,
  schema: OpenApiSchema | undefined,
): ResponseExample | undefined {
  const resolved = resolveComponent(raw, doc.components?.examples, 'examples');
  if (!resolved) return undefined;
  const example: ResponseExample = {};
  if (name !== undefined) example.name = name;
  if (resolved.summary) example.summary = resolved.summary;
  if (resolved.description) example.description = resolved.description;
  if (Object.hasOwn(resolved, 'value') && isJsonValue(resolved.value)) {
    const value = pruneIgnoredExampleFields(doc, schema, resolved.value);
    if (value !== undefined) example.value = value;
  }
  if (resolved.externalValue) example.externalValue = resolved.externalValue;
  return example;
}

function explicitResponseExamples(
  doc: OpenApiDocumentSchema,
  media: MediaTypeSchema,
  schema: OpenApiSchema | undefined,
): ResponseExample[] {
  const examples: ResponseExample[] = [];
  // Although OpenAPI declares `example` and `examples` mutually exclusive, retain
  // both in their object order when a source contains both.
  for (const field of Object.keys(media)) {
    if (field === 'example' && isJsonValue(media.example)) {
      const value = pruneIgnoredExampleFields(doc, schema, media.example);
      if (value !== undefined) examples.push({ value });
      continue;
    }
    if (field !== 'examples') continue;
    for (const [name, raw] of Object.entries(media.examples ?? {})) {
      const example = normalizeExample(doc, name, raw, schema);
      if (example) examples.push(example);
    }
  }
  return examples;
}

function exampleBodyRepresentation(
  content: Record<string, MediaTypeSchema | undefined> | undefined,
): { mediaType: string; schema: OpenApiSchema } | undefined {
  const representations = Object.entries(content ?? {});
  const representation =
    representations.find(([mediaType, media]) => isJsonMediaType(mediaType) && media?.schema) ??
    representations.find(([, media]) => media?.schema);
  return representation?.[1]?.schema ? { mediaType: representation[0], schema: representation[1].schema } : undefined;
}

function operationRequestExampleRepresentation(
  doc: OpenApiDocumentSchema,
  op: OperationSchema,
): { mediaType: string; schema: OpenApiSchema } | undefined {
  return exampleBodyRepresentation(
    resolveComponent(op.requestBody, doc.components?.requestBodies, 'requestBodies')?.content,
  );
}

function operationResponseExampleRepresentation(
  doc: OpenApiDocumentSchema,
  op: OperationSchema,
): { mediaType: string; schema: OpenApiSchema } | undefined {
  const responses = Object.entries(op.responses ?? {});
  const ordered = [
    ...responses.filter(([status]) => classifyResponseStatus(status) === 'success'),
    ...responses.filter(([status]) => classifyResponseStatus(status) !== 'success'),
  ];
  for (const [, raw] of ordered) {
    const representation = exampleBodyRepresentation(
      resolveComponent(raw, doc.components?.responses, 'responses')?.content,
    );
    if (representation) return representation;
  }
  return undefined;
}

function omitIgnoredParameterValues(
  doc: OpenApiDocumentSchema,
  pathItem: PathItemSchema,
  op: OperationSchema,
  where: ParameterSchema['in'],
  values: Record<string, JsonValueSchema> | undefined,
): Record<string, JsonValueSchema> | undefined {
  if (!values) return undefined;
  const ignored = new Map<string, boolean>();
  for (const raw of [...(pathItem.parameters ?? []), ...(op.parameters ?? [])]) {
    const parameter = resolveParam(doc, raw);
    if (!parameter || parameter.in !== where || !parameter.name) continue;
    ignored.set(parameter.name, isParameterIgnored(doc, raw));
  }
  return Object.fromEntries(Object.entries(values).filter(([name]) => ignored.get(name) !== true));
}

function operationExamples(
  doc: OpenApiDocumentSchema,
  pathItem: PathItemSchema,
  op: OperationSchema,
): OperationExampleSchema[] {
  const requestRepresentation = operationRequestExampleRepresentation(doc, op);
  const responseRepresentation = operationResponseExampleRepresentation(doc, op);
  return (op['x-fern-examples'] ?? []).map((source) => {
    const pathParameters = omitIgnoredParameterValues(doc, pathItem, op, 'path', source['path-parameters']);
    const queryParameters = omitIgnoredParameterValues(doc, pathItem, op, 'query', source['query-parameters']);
    const headers = omitIgnoredParameterValues(doc, pathItem, op, 'header', source.headers);
    const requestBody =
      source.request !== undefined
        ? pruneIgnoredExampleFields(doc, requestRepresentation?.schema, source.request)
        : undefined;
    const responseBody = source.response
      ? pruneIgnoredExampleFields(doc, responseRepresentation?.schema, source.response.body)
      : undefined;
    const request = {
      ...(pathParameters !== undefined ? { pathParameters } : {}),
      ...(queryParameters !== undefined ? { queryParameters } : {}),
      ...(headers !== undefined ? { headers } : {}),
      ...(requestBody !== undefined ? { body: requestBody } : {}),
      ...(requestBody !== undefined && requestRepresentation && !isJsonMediaType(requestRepresentation.mediaType)
        ? { bodyMediaType: requestRepresentation.mediaType }
        : {}),
    };
    const codeSamples = (source['code-samples'] ?? []).map<OperationCodeSampleSchema>((sample) => {
      if ('sdk' in sample && sample.sdk !== undefined) {
        return { kind: 'sdk', sdk: fernSdkCodeSampleNameParserSchema.parse(sample.sdk), code: sample.code };
      }
      return {
        kind: 'language',
        language: sample.language,
        ...(sample.install !== undefined ? { install: sample.install } : {}),
        code: sample.code,
      };
    });
    return {
      ...(source.name !== undefined ? { name: source.name } : {}),
      ...(Object.keys(request).length > 0 ? { request } : {}),
      ...(responseBody !== undefined
        ? {
            response: {
              body: responseBody,
              ...(responseRepresentation && !isJsonMediaType(responseRepresentation.mediaType)
                ? { mediaType: responseRepresentation.mediaType }
                : {}),
            },
          }
        : {}),
      codeSamples,
    };
  });
}

function isClearlyNonTextualMediaType(mediaType: string): boolean {
  const essence = mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (/^(?:image|audio|video)\//.test(essence)) return true;
  return (
    essence === 'application/octet-stream' ||
    essence === 'application/pdf' ||
    essence === 'application/zip' ||
    essence === 'application/x-zip' ||
    essence === 'application/x-zip-compressed' ||
    essence.endsWith('+zip')
  );
}

function supportsGeneratedExample(doc: OpenApiDocumentSchema, mediaType: string, schema: OpenApiSchema): boolean {
  if (isJsonMediaType(mediaType)) return true;
  if (isClearlyNonTextualMediaType(mediaType)) return false;
  return schemaTypes(structuredSchema(resolveSchema(doc, schema) ?? schema)?.type).includes('string');
}

function responseRepresentation(
  doc: OpenApiDocumentSchema,
  status: string,
  rawMediaType: string,
  media: MediaTypeSchema | undefined,
  responsePayloadKey: string | undefined,
  suppressGeneratedExample: boolean,
): ResponseRepresentation | undefined {
  const mediaType = rawMediaType.trim();
  if (!mediaType) return undefined;
  const rawSchema = media?.schema;
  const schema = rawSchema ? buildSchemaNode(doc, rawSchema, { required: false, depth: 0, seen: new Set() }) : null;
  const examples = media ? explicitResponseExamples(doc, media, rawSchema) : [];
  const representation: ResponseRepresentation = { mediaType, schema, examples };

  if (responsePayloadKey && classifyResponseStatus(status) === 'success' && rawSchema) {
    const root = gatherObjectSchema(doc, rawSchema);
    if (root?.properties?.[responsePayloadKey] !== undefined) representation.payloadKey = responsePayloadKey;
  }

  if (
    examples.length === 0 &&
    !suppressGeneratedExample &&
    rawSchema &&
    schema?.format?.toLowerCase() !== 'binary' &&
    supportsGeneratedExample(doc, mediaType, rawSchema)
  ) {
    const generatedExample = schemaExample(doc, rawSchema);
    if (generatedExample !== undefined) representation.generatedExample = generatedExample;
  }
  return representation;
}

function extractResponses(
  doc: OpenApiDocumentSchema,
  op: OperationSchema,
  responsePayloadKey?: string,
  suppressGeneratedExample = false,
): OperationResponse[] {
  return Object.entries(op.responses ?? {}).map(([status, rawResponse]) => {
    const response = resolveComponent(rawResponse, doc.components?.responses, 'responses');
    const representations = Object.entries(response?.content ?? {}).flatMap<ResponseRepresentation>(
      ([mediaType, media]) => {
        const representation = responseRepresentation(
          doc,
          status,
          mediaType,
          media,
          responsePayloadKey,
          suppressGeneratedExample,
        );
        return representation ? [representation] : [];
      },
    );
    return {
      status,
      description: response?.description ?? '',
      representations,
    };
  });
}

export function resolveOperation(
  doc: OpenApiDocumentSchema,
  pathItem: PathItemSchema,
  method: HttpMethod,
  op: OperationSchema,
  responsePayloadKey?: string,
): ResolvedOperation {
  const params = effectiveParameters(doc, pathItem.parameters ?? [], op.parameters ?? []);
  const requestBody = extractRequestBody(doc, op);
  const examples = operationExamples(doc, pathItem, op);
  return {
    method,
    path: '', // filled by caller (it knows the path template)
    description: op.description ?? '',
    pathParams: extractParamNodes(doc, params, 'path'),
    queryParams: extractParamNodes(doc, params, 'query'),
    requestBody,
    responses: extractResponses(
      doc,
      op,
      responsePayloadKey,
      examples.some((example) => example.response !== undefined),
    ),
    examples,
  };
}
//#endregion
