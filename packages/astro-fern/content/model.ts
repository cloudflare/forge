/**
 * The Docs Model — the stable, serializable contract the rendering layer
 * (astro-fern and its renderers) consumes. It is a pure function of the overlaid
 * OpenAPI spec, so it can never drift from the API.
 */
import type {
  RenderedOperationResponseSchema,
  RenderedOperationSchema,
  RenderedEnumValueMetadataSchema,
  RenderedRequestBodySchema,
  RenderedRequestRepresentationSchema,
  RenderedResponseExampleSchema,
  RenderedResponseRepresentationSchema,
  RenderedSchemaNodeSchema,
} from './schema.ts';
import type { Snippet } from '../snippets/index.ts';

/** Fern metadata for one wire enum value before Markdown enrichment. */
export type EnumValueMetadata = Omit<RenderedEnumValueMetadataSchema, 'description'> & {
  description?: string;
};

/**
 * A node in a recursive source schema tree before Markdown enrichment. Scalars
 * have no recursive members; objects carry `children`, arrays carry `items`, and
 * `oneOf`/`anyOf` unions carry `variants`.
 *
 * The leaf shape is derived from {@link RenderedSchemaNodeSchema}, keeping the
 * source and runtime schemas synchronized while replacing rich descriptions and
 * recursive members with source-model forms.
 */
export type SchemaNode = Omit<
  RenderedSchemaNodeSchema,
  'description' | 'enumValueMetadata' | 'children' | 'items' | 'variants'
> & {
  /** Raw Markdown (the loader enriches this to `RichTextSchema`). */
  description?: string;
  /** Fern metadata for selected wire enum values. */
  enumValueMetadata?: EnumValueMetadata[];
  /** Object properties. */
  children?: SchemaNode[];
  /** Array element schema. */
  items?: SchemaNode;
  /** `oneOf` / `anyOf` alternatives. */
  variants?: SchemaNode[];
};

/** Source request representation before Markdown descriptions are enriched. */
export type RequestRepresentation = Omit<RenderedRequestRepresentationSchema, 'schema'> & {
  schema: SchemaNode | null;
};

/** Source request body before its Markdown description and schemas are enriched. */
export type RequestBody = Omit<RenderedRequestBodySchema, 'description' | 'representations'> & {
  description?: string;
  representations: RequestRepresentation[];
};

/** Source response example before its Markdown description is enriched. */
export type ResponseExample = Omit<RenderedResponseExampleSchema, 'description'> & {
  description?: string;
};

/** Source response representation before its schema and examples are enriched. */
export type ResponseRepresentation = Omit<RenderedResponseRepresentationSchema, 'schema' | 'examples'> & {
  schema: SchemaNode | null;
  examples: ResponseExample[];
};

/** Source OpenAPI response before its Markdown description and representations are enriched. */
export type OperationResponse = Omit<RenderedOperationResponseSchema, 'description' | 'representations'> & {
  description: string;
  representations: ResponseRepresentation[];
};

/**
 * The **source** operation produced by the builder, derived from the enriched
 * {@link RenderedOperationSchema} (the Zod source of truth). It differs in exactly
 * three ways: Markdown is raw text; the parameter/body/response trees
 * are source {@link SchemaNode}s (not yet enriched); and it additionally carries
 * the rendered `snippets` (which the enriched operation drops, since a page's
 * `targets` carry the code). All other fields — `operationId`, `slug`, `title`,
 * `httpMethod`, `path`, `availability`, `deprecated`, and `requireConfirmation`,
 * SDK resource placement, and namespaced `extensions` are
 * inherited and so can't drift.
 */
export type DocOperation = Omit<
  RenderedOperationSchema,
  'description' | 'pathParams' | 'queryParams' | 'requestBody' | 'responses'
> & {
  /** Raw Markdown description (enriched to `RichTextSchema` by the operations loader). */
  description: string;
  pathParams: SchemaNode[];
  queryParams: SchemaNode[];
  /** Request-body metadata and representations; `null` when there is no body. */
  requestBody: RequestBody | null;
  /** Every declared OpenAPI response, in source order. */
  responses: OperationResponse[];
  snippets: Snippet[];
};

/** Manifest-owned documentation section populated from one exact OpenAPI tag. */
export interface DocSection {
  /** Stable manifest-defined identifier used in documentation URLs. */
  id: string;
  /** Exact OpenAPI tag that assigns operations to this section. */
  tag: string;
  /** Human-facing section label. */
  title: string;
  /** Stable manifest-defined URL segment. */
  slug: string;
  /** Operations assigned to this section, sorted by title and then operation ID. */
  operations: DocOperation[];
}

/** Route-neutral product in the resolved documentation model. */
export interface DocProduct {
  /** Canonical manifest product identity. */
  name: string;
  /** Configured display label, or an identifier-derived default. */
  title: string;
  /** Product summary used by overview and agent surfaces. */
  description: string;
  /** Stable product URL segment. */
  slug: string;
  /** Manifest sections in configured order. */
  sections: DocSection[];
}

/** Stable serializable model produced directly from OpenAPI and consumer policies. */
export interface DocsModel {
  /** Raw Markdown from the top-level OpenAPI `info.description`. */
  description?: string;
  /** Resolved products in manifest order. */
  products: DocProduct[];
}
