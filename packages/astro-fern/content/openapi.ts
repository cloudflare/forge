import { z } from 'astro/zod';

const fernEnumValueSchema = z.object({
  description: z.string().optional(),
  deprecated: z.boolean().optional(),
  name: z.string().optional(),
  casing: z
    .object({
      snake: z.string().optional(),
      camel: z.string().optional(),
      screamingSnake: z.string().optional(),
      pascal: z.string().optional(),
    })
    .optional(),
});

const fernSdkCodeSampleSourceNameSchema = z.enum([
  'curl',
  'python',
  'javascript',
  'typescript',
  'go',
  'ruby',
  'csharp',
  'java',
  'js',
  'node',
  'ts',
  'nodets',
  'golang',
  'dotnet',
  'jvm',
  'c#',
]);

/** Normalizes common Fern SDK aliases to the canonical code-sample target names. */
export const fernSdkCodeSampleNameParserSchema = z.preprocess(
  (value) => {
    if (value === 'js' || value === 'node') return 'javascript';
    if (value === 'ts' || value === 'nodets') return 'typescript';
    if (value === 'golang') return 'go';
    if (value === 'dotnet' || value === 'c#') return 'csharp';
    if (value === 'jvm') return 'java';
    return value;
  },
  z.enum(['curl', 'python', 'javascript', 'typescript', 'go', 'ruby', 'csharp', 'java']),
);

const fernCodeSampleSchema = z.union([
  z.object({
    sdk: fernSdkCodeSampleSourceNameSchema,
    language: z.never().optional(),
    code: z.string(),
  }),
  z.object({
    language: z.string().min(1),
    sdk: z.never().optional(),
    install: z.string().optional(),
    code: z.string(),
  }),
]);

const fernOperationExampleSchema = z.object({
  name: z.string().optional(),
  'path-parameters': z.record(z.string(), z.json()).optional(),
  'query-parameters': z.record(z.string(), z.json()).optional(),
  headers: z.record(z.string(), z.json()).optional(),
  request: z.json().optional(),
  response: z.object({ body: z.json() }).optional(),
  'code-samples': z.array(fernCodeSampleSchema).optional(),
});

/** Structured OpenAPI schema fields consumed by the documentation resolver. */
export const structuredOpenApiSchema = z.looseObject({
  $ref: z.string().optional(),
  title: z.string().optional(),
  type: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
  format: z.string().optional(),
  description: z.string().optional(),
  enum: z.array(z.unknown()).optional(),
  default: z.unknown().optional(),
  get items() {
    return openApiSchema.optional();
  },
  get properties() {
    return z.record(z.string(), openApiSchema).optional();
  },
  required: z.array(z.string()).optional(),
  get allOf() {
    return z.array(openApiSchema).optional();
  },
  get oneOf() {
    return z.array(openApiSchema).optional();
  },
  get anyOf() {
    return z.array(openApiSchema).optional();
  },
  deprecated: z.boolean().optional(),
  example: z.unknown().optional(),
  examples: z.array(z.unknown()).optional(),
  minimum: z.number().optional(),
  nullable: z.boolean().optional(),
  'x-fern-enum': z.record(z.string(), fernEnumValueSchema).optional(),
  'x-fern-property-name': z.string().trim().min(1).optional(),
  'x-fern-ignore': z.unknown().optional(),
});
/** Parsed OpenAPI schema fields recognized by the resolver, with unknown fields preserved. */
export type StructuredOpenApiSchema = z.infer<typeof structuredOpenApiSchema>;

/** OpenAPI 3.0 schema objects and OpenAPI 3.1 boolean JSON Schemas. */
export const openApiSchema = z.union([structuredOpenApiSchema, z.boolean()]);
/** Parsed OpenAPI 3.0 schema fields or an OpenAPI 3.1 boolean JSON Schema. */
export type OpenApiSchema = z.infer<typeof openApiSchema>;

/** Loose validator for OpenAPI parameter and reference objects consumed by astro-fern. */
export const parameterSchema = z.looseObject({
  $ref: z.string().optional(),
  name: z.string().optional(),
  in: z.enum(['path', 'query', 'header', 'cookie']).optional(),
  required: z.boolean().optional(),
  description: z.string().optional(),
  schema: openApiSchema.optional(),
  'x-fern-ignore': z.unknown().optional(),
});
/** Parsed parameter/reference fields recognized by astro-fern, with unknown fields preserved. */
export type ParameterSchema = z.infer<typeof parameterSchema>;

/** Loose validator for reusable or inline OpenAPI examples. */
export const exampleSchema = z.looseObject({
  $ref: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  value: z.unknown().optional(),
  externalValue: z.string().optional(),
});
/** Parsed example/reference fields recognized by astro-fern, with unknown fields preserved. */
export type ExampleSchema = z.infer<typeof exampleSchema>;

/** Loose validator for one OpenAPI media-type representation. */
export const mediaTypeSchema = z.looseObject({
  schema: openApiSchema.optional(),
  example: z.unknown().optional(),
  examples: z.record(z.string(), exampleSchema).optional(),
});
/** Parsed media-type fields recognized by astro-fern, with unknown fields preserved. */
export type MediaTypeSchema = z.infer<typeof mediaTypeSchema>;

/** Loose validator for OpenAPI request-body and reference objects. */
export const requestBodySchema = z.looseObject({
  $ref: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  content: z.record(z.string(), mediaTypeSchema).optional(),
});
/** Parsed request-body/reference fields recognized by astro-fern, with unknown fields preserved. */
export type RequestBodySchema = z.infer<typeof requestBodySchema>;

/** Loose validator for OpenAPI response and reference objects. */
export const responseSchema = z.looseObject({
  $ref: z.string().optional(),
  description: z.string().optional(),
  content: z.record(z.string(), mediaTypeSchema).optional(),
});
/** Parsed response/reference fields recognized by astro-fern, with unknown fields preserved. */
export type ResponseSchema = z.infer<typeof responseSchema>;

/** Loose validator for operation fields and Fern extensions consumed by astro-fern. */
export const operationSchema = z.looseObject({
  operationId: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  deprecated: z.boolean().optional(),
  tags: z.array(z.string().min(1)).optional(),
  parameters: z.array(parameterSchema).optional(),
  requestBody: requestBodySchema.optional(),
  responses: z.record(z.string(), responseSchema).optional(),
  // Generic astro-fern preserves Fern headers; consumer extensions own their contracts.
  'x-fern-sdk-group-name': z.unknown().optional(),
  'x-fern-sdk-method-name': z.unknown().optional(),
  'x-fern-availability': z.unknown().optional(),
  'x-fern-ignore': z.unknown().optional(),
  'x-fern-examples': z.array(fernOperationExampleSchema).optional(),
});
/** Parsed operation fields recognized by astro-fern, with unknown fields preserved. */
export type OperationSchema = z.infer<typeof operationSchema>;

/** Loose validator for an OpenAPI path item and its supported HTTP operations. */
export const pathItemSchema = z.looseObject({
  parameters: z.array(parameterSchema).optional(),
  get: operationSchema.optional(),
  post: operationSchema.optional(),
  put: operationSchema.optional(),
  patch: operationSchema.optional(),
  delete: operationSchema.optional(),
  options: operationSchema.optional(),
  head: operationSchema.optional(),
  trace: operationSchema.optional(),
});
/** Parsed path-item fields recognized by astro-fern, with unknown fields preserved. */
export type PathItemSchema = z.infer<typeof pathItemSchema>;

const componentsSchema = z.looseObject({
  schemas: z.record(z.string(), openApiSchema).optional(),
  parameters: z.record(z.string(), parameterSchema).optional(),
  examples: z.record(z.string(), exampleSchema).optional(),
  requestBodies: z.record(z.string(), requestBodySchema).optional(),
  responses: z.record(z.string(), responseSchema).optional(),
});

/** A loose OpenAPI document schema that validates every field consumed by astro-fern. */
export const openApiDocumentSchema = z.looseObject({
  info: z.looseObject({ description: z.string().optional() }).optional(),
  components: componentsSchema.optional(),
  paths: z.record(z.string(), pathItemSchema).optional(),
});
/** Parsed OpenAPI document fields consumed by astro-fern, with unknown fields preserved. */
export type OpenApiDocumentSchema = z.infer<typeof openApiDocumentSchema>;
