/**
 * Zod schemas + inferred types for the compact catalog and enriched operation artifacts.
 *
 * Astro's eager content store contains only the project index. Each enriched
 * operation is emitted as an immutable public artifact and read through a Live
 * Collection. Neither shape contains mounted paths, runtime routing options, or
 * agent links; those are composed by `astro-fern/server` from the integration's
 * virtual runtime configuration.
 *
 * The "enriched" bit: Markdown descriptions in operation artifacts, schema nodes,
 * responses, and response examples are rendered to HTML at load time and stored
 * as {@link RichTextSchema} (`{ markdown, html }`). Renderers emit the HTML via
 * `set:html`; agents keep using the raw Markdown. This module is the single
 * source of truth for that shape.
 *
 * Import surface: `astro/zod` (Zod v4) only — no `astro:content`, no project
 * types — so it stays framework-data-independent and resolves under
 * `node --experimental-strip-types` for the package's unit tests.
 */
import { z } from 'astro/zod';
import { FERN_ARTIFACT_DIGEST_PATTERN, FERN_ARTIFACT_FORMAT_VERSION } from '../content-contract.ts';

//#region Leaf schemas

/** A Markdown description rendered once at load time: the raw source and its HTML. */
export const richTextSchema = z.object({
  /** Original Markdown source (what agents/llms.txt consume). */
  markdown: z.string(),
  /** Rendered HTML (what the human docs emit via `set:html`). */
  html: z.string(),
});
/** Raw Markdown paired with the HTML rendered from it at content-load time. */
export type RichTextSchema = z.infer<typeof richTextSchema>;

/**
 * Validates normalized `{ status, message? }` availability metadata stored in
 * generated content. Source strings are normalized before this schema is applied.
 */
export const availabilitySchema = z.object({
  status: z.string(),
  message: z.string().optional(),
});
/** Normalized operation-availability metadata. */
export type AvailabilitySchema = z.infer<typeof availabilitySchema>;

/** Execution-target kind shared by content and renderer-facing schemas. */
export const targetKindSchema = z.enum(['http', 'cli', 'sdk', 'tool']);

/** The scope a generated `llms.txt` index covers (mirrors project.ts `AgentScope`). */
export const agentScopeSchema = z.enum(['site', 'product', 'snapshot', 'target']);

/** A serializable JSON value used throughout normalized content. */
export const jsonValueSchema = z.json();
/** Serializable JSON value used by examples, extensions, and generated content. */
export type JsonValueSchema = z.infer<typeof jsonValueSchema>;

/** Lowercase SHA-256 digest identifying exact serialized artifact bytes. */
export const fernArtifactDigestSchema = z.string().regex(FERN_ARTIFACT_DIGEST_PATTERN);

const enumScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

/** Fern enum-value metadata after Markdown description enrichment. */
export const renderedEnumValueMetadataSchema = z.object({
  value: enumScalarSchema,
  description: richTextSchema.optional(),
  deprecated: z.boolean().optional(),
});
/** Rendered metadata associated with one wire enum value. */
export type RenderedEnumValueMetadataSchema = z.infer<typeof renderedEnumValueMetadataSchema>;

/** An object with string keys whose values have not been validated yet. */
export const unknownRecordSchema = z.record(z.string(), z.unknown());

//#endregion

//#region Rendered schema tree

/**
 * A schema-tree node with its `description` enriched to {@link RichTextSchema}. This
 * schema is the single source of truth for a node's shape: the **source**
 * `SchemaNode` (content/model.ts) is *derived* from {@link RenderedSchemaNodeSchema}
 * (swapping `description` back to raw Markdown and re-pointing recursion at the
 * source node), so the two can't drift apart.
 *
 * Recursion uses Zod v4's lazy-getter pattern (`get children()`), so `z.infer`
 * derives {@link RenderedSchemaNodeSchema} directly — no hand-written interface and no
 * `z.ZodType<T>` annotation (which clashes with `exactOptionalPropertyTypes`).
 * The resolver caps depth (MAX_DEPTH), so the tree is always finite.
 */
export const renderedSchemaNodeSchema = z.object({
  name: z.string().optional(),
  /** Generated SDK identifier; `name` remains the OpenAPI wire name. */
  sdkName: z.string().optional(),
  title: z.string().optional(),
  type: z.string(),
  format: z.string().optional(),
  required: z.boolean(),
  description: richTextSchema.optional(),
  enumValues: z.array(enumScalarSchema).optional(),
  enumValueMetadata: z.array(renderedEnumValueMetadataSchema).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  deprecated: z.boolean().optional(),
  get children() {
    return z.array(renderedSchemaNodeSchema).optional();
  },
  get items() {
    return renderedSchemaNodeSchema.optional();
  },
  get variants() {
    return z.array(renderedSchemaNodeSchema).optional();
  },
  apiFieldPath: z.array(z.string()).optional(),
});
/** Recursive renderer-facing schema node with enriched descriptions. */
export type RenderedSchemaNodeSchema = z.infer<typeof renderedSchemaNodeSchema>;

/** One media-type representation declared by an OpenAPI request body. */
export const renderedRequestRepresentationSchema = z.object({
  mediaType: z.string().min(1),
  schema: renderedSchemaNodeSchema.nullable(),
});
/** Renderer-facing request media-type representation. */
export type RenderedRequestRepresentationSchema = z.infer<typeof renderedRequestRepresentationSchema>;

/** Request-body metadata and every declared media-type representation. */
export const renderedRequestBodySchema = z.object({
  required: z.boolean(),
  description: richTextSchema.optional(),
  representations: z.array(renderedRequestRepresentationSchema),
});
/** Renderer-facing request body with enriched descriptions and representations. */
export type RenderedRequestBodySchema = z.infer<typeof renderedRequestBodySchema>;

/** One explicit OpenAPI response example, including component-ref metadata. */
export const renderedResponseExampleSchema = z.object({
  name: z.string().optional(),
  summary: z.string().optional(),
  description: richTextSchema.optional(),
  value: jsonValueSchema.optional(),
  externalValue: z.string().optional(),
});
/** Renderer-facing explicit response example with an enriched description. */
export type RenderedResponseExampleSchema = z.infer<typeof renderedResponseExampleSchema>;

/** Canonical SDK names supported by normalized Fern code samples. */
export const fernSdkCodeSampleNameSchema = z.enum([
  'curl',
  'python',
  'javascript',
  'typescript',
  'go',
  'ruby',
  'csharp',
  'java',
]);

/** A normalized Fern SDK or custom-language code sample. */
export const operationCodeSampleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sdk'), sdk: fernSdkCodeSampleNameSchema, code: z.string() }),
  z.object({
    kind: z.literal('language'),
    language: z.string().min(1),
    install: z.string().optional(),
    code: z.string(),
  }),
]);
/** Normalized code sample attached to a Fern operation example. */
export type OperationCodeSampleSchema = z.infer<typeof operationCodeSampleSchema>;

/** A normalized Fern operation request/response example and its code samples. */
export const operationExampleSchema = z.object({
  name: z.string().optional(),
  request: z
    .object({
      pathParameters: z.record(z.string(), jsonValueSchema).optional(),
      queryParameters: z.record(z.string(), jsonValueSchema).optional(),
      headers: z.record(z.string(), jsonValueSchema).optional(),
      body: jsonValueSchema.optional(),
      bodyMediaType: z.string().min(1).optional(),
    })
    .optional(),
  response: z.object({ body: jsonValueSchema, mediaType: z.string().min(1).optional() }).optional(),
  codeSamples: z.array(operationCodeSampleSchema),
});
/** Renderer-facing request, response, and code-sample data for one Fern operation example. */
export type OperationExampleSchema = z.infer<typeof operationExampleSchema>;

/** One media-type representation declared by an OpenAPI response. */
export const renderedResponseRepresentationSchema = z.object({
  mediaType: z.string().min(1),
  schema: renderedSchemaNodeSchema.nullable(),
  payloadKey: z.string().min(1).optional(),
  examples: z.array(renderedResponseExampleSchema),
  generatedExample: jsonValueSchema.optional(),
});
/** Renderer-facing response media type, schema, and examples. */
export type RenderedResponseRepresentationSchema = z.infer<typeof renderedResponseRepresentationSchema>;

/** One status entry from an operation's ordered OpenAPI response map. */
export const renderedOperationResponseSchema = z.object({
  status: z.string(),
  description: richTextSchema,
  representations: z.array(renderedResponseRepresentationSchema),
});
/** Renderer-facing OpenAPI response status entry. */
export type RenderedOperationResponseSchema = z.infer<typeof renderedOperationResponseSchema>;

//#endregion

//#region Operation + page

/** One human-facing resource segment derived from a Fern SDK group segment. */
export const resourcePathSegmentSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().min(1),
});
export type ResourcePathSegmentSchema = z.infer<typeof resourcePathSegmentSchema>;

/** The selected SDK projection that places an operation in the resource tree. */
export const operationPlacementSchema = z.object({
  projectionId: z.string().min(1),
  resourcePath: z.array(resourcePathSegmentSchema),
  method: z.object({ id: z.string().min(1), slug: z.string().min(1) }),
});
export type OperationPlacementSchema = z.infer<typeof operationPlacementSchema>;

/** One rendered operation, and the single source of truth for the operation
 * shape: the source `DocOperation` (content/model.ts) is derived from it. Here
 * `description` is enriched to {@link RichTextSchema} and `snippets` is dropped (the
 * page's `targets` already carry the rendered code). */
export const renderedOperationSchema = z.object({
  operationId: z.string(),
  slug: z.string(),
  /** SDK-backed resource placement. Absent when the product does not declare `sdkGroup`. */
  placement: operationPlacementSchema.optional(),
  title: z.string(),
  httpMethod: z.string(),
  path: z.string(),
  description: richTextSchema,
  availability: availabilitySchema.optional(),
  deprecated: z.boolean(),
  requireConfirmation: z.string().optional(),
  /** Serializable data isolated by configured extension name. */
  extensions: z.record(z.string(), jsonValueSchema),
  /** Associated request, response, and custom code examples from `x-fern-examples`. */
  examples: z.array(operationExampleSchema).optional(),
  pathParams: z.array(renderedSchemaNodeSchema),
  queryParams: z.array(renderedSchemaNodeSchema),
  requestBody: renderedRequestBodySchema.nullable(),
  responses: z.array(renderedOperationResponseSchema),
});
/** Renderer-facing operation after Markdown and schema enrichment. */
export type RenderedOperationSchema = z.infer<typeof renderedOperationSchema>;

/** A resolved execution target (config + rendered snippet + hrefs). Structurally
 * a `FernTargetConfig` plus the resolved code/href fields. */
export const executionTargetSchema = z.object({
  id: z.string(),
  kind: targetKindSchema,
  label: z.string(),
  language: z.string(),
  packageName: z.string().optional(),
  version: z.string().optional(),
  code: z.string().nullable(),
  syntax: z.string(),
  href: z.string(),
  markdownHref: z.string().optional(),
});
/** Resolved execution target with rendered code and public links. */
export type FernExecutionTargetSchema = z.infer<typeof executionTargetSchema>;

export const agentLinksSchema = z.object({
  // Absent when `agents.markdown` is disabled — there is no aggregate `.md` route to link.
  // Per-target Markdown lives on each `targets[].markdownHref` (same switch).
  markdown: z.object({ href: z.string(), mediaType: z.literal('text/markdown') }).optional(),
  llms: z.array(z.object({ scope: agentScopeSchema, href: z.string() })),
});
/** Generated Markdown and llms.txt relationships for an operation page. */
export type FernAgentLinksSchema = z.infer<typeof agentLinksSchema>;

/** Renderer-facing page composed at runtime from content plus route data. */
export const apiOperationEntrySchema = z.object({
  id: z.string(),
  entryId: z.string(),
  pathname: z.string(),
  product: z.object({ id: z.string(), slug: z.string(), title: z.string(), description: z.string() }),
  section: z.object({ id: z.string(), tag: z.string(), title: z.string() }),
  snapshot: z.object({ id: z.string(), label: z.string(), default: z.boolean() }),
  operation: renderedOperationSchema,
  targets: z.array(executionTargetSchema),
  agentLinks: agentLinksSchema,
});
/** Complete renderer-facing operation page composed at request time. */
export type FernPageSchema = z.infer<typeof apiOperationEntrySchema>;

/** Route-neutral generated snippet stored in one operation snapshot artifact. */
export const contentSnippetSchema = z.object({
  targetId: z.string(),
  code: z.string().nullable(),
  syntax: z.string(),
});
export type FernContentSnippetSchema = z.infer<typeof contentSnippetSchema>;

export const contentTargetSchema = z.object({
  id: z.string(),
  kind: targetKindSchema,
  label: z.string(),
  language: z.string(),
  packageName: z.string().optional(),
  version: z.string().optional(),
});
export type FernContentTargetSchema = z.infer<typeof contentTargetSchema>;

export const contentCatalogOperationSchema = z.object({
  entryId: z.string(),
  operationId: z.string(),
  slug: z.string(),
  placement: operationPlacementSchema.optional(),
  title: z.string(),
  description: z.string(),
  httpMethod: z.string(),
});
export type FernContentCatalogOperationSchema = z.infer<typeof contentCatalogOperationSchema>;

/** Snapshot-owned catalog operation after its exact immutable artifact bytes have been addressed. */
export const contentArtifactCatalogOperationSchema = contentCatalogOperationSchema.extend({
  artifactDigest: fernArtifactDigestSchema,
});
export type FernContentArtifactCatalogOperationSchema = z.infer<typeof contentArtifactCatalogOperationSchema>;

const contentCatalogSectionSchema = z.object({
  id: z.string(),
  tag: z.string(),
  title: z.string(),
  operations: z.array(contentCatalogOperationSchema),
});

const contentArtifactCatalogSectionSchema = contentCatalogSectionSchema.extend({
  operations: z.array(contentArtifactCatalogOperationSchema),
});

const contentCatalogSnapshotBaseSchema = z.object({
  id: z.string(),
  slug: z.string(),
  label: z.string(),
  default: z.boolean(),
  targets: z.array(contentTargetSchema),
});

const contentCatalogSnapshotSchema = contentCatalogSnapshotBaseSchema.extend({
  /** Sections and operations present in this exact product snapshot. */
  sections: z.array(contentCatalogSectionSchema),
});

const contentArtifactCatalogSnapshotSchema = contentCatalogSnapshotBaseSchema.extend({
  /** Snapshot-owned operation references paired with their exact artifact digests. */
  sections: z.array(contentArtifactCatalogSectionSchema),
});

const contentCatalogProductSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  snapshots: z.array(contentCatalogSnapshotSchema),
});

const contentArtifactCatalogProductSchema = contentCatalogProductSchema.extend({
  snapshots: z.array(contentArtifactCatalogSnapshotSchema),
});

type CatalogSnapshotIdentity = z.infer<typeof contentCatalogSnapshotBaseSchema>;

function catalogSnapshotIssues(catalog: {
  snapshots: CatalogSnapshotIdentity[];
  products: Array<{ id: string; snapshots: CatalogSnapshotIdentity[] }>;
}): Array<{ path: (string | number)[]; message: string }> {
  const issues: Array<{ path: (string | number)[]; message: string }> = [];
  const registry = new Map<string, { index: number; snapshot: CatalogSnapshotIdentity }>();
  const slugs = new Set<string>();
  const defaults = catalog.snapshots.filter((snapshot) => snapshot.default);

  catalog.snapshots.forEach((snapshot, index) => {
    if (registry.has(snapshot.id)) {
      issues.push({
        path: ['snapshots', index, 'id'],
        message: `global snapshot ID "${snapshot.id}" is duplicated; keep one registry entry per snapshot`,
      });
    } else {
      registry.set(snapshot.id, { index, snapshot });
    }
    if (slugs.has(snapshot.slug)) {
      issues.push({
        path: ['snapshots', index, 'slug'],
        message: `global snapshot slug "${snapshot.slug}" is duplicated; give every snapshot a distinct slug`,
      });
    }
    slugs.add(snapshot.slug);
  });
  if (defaults.length !== 1) {
    issues.push({
      path: ['snapshots'],
      message: `global snapshot registry has ${defaults.length} defaults; mark exactly one snapshot as default`,
    });
  }

  catalog.products.forEach((product, productIndex) => {
    const seen = new Set<string>();
    let previousRegistryIndex = -1;
    product.snapshots.forEach((snapshot, snapshotIndex) => {
      const path = ['products', productIndex, 'snapshots', snapshotIndex] as (string | number)[];
      if (seen.has(snapshot.id)) {
        issues.push({
          path: [...path, 'id'],
          message: `product "${product.id}" repeats snapshot "${snapshot.id}"; keep one entry per snapshot`,
        });
      }
      seen.add(snapshot.id);

      const registered = registry.get(snapshot.id);
      if (!registered) {
        issues.push({
          path: [...path, 'id'],
          message: `product "${product.id}" references snapshot "${snapshot.id}" outside catalog.snapshots; add it to the global registry or remove this product snapshot`,
        });
        return;
      }
      if (registered.index < previousRegistryIndex) {
        issues.push({
          path,
          message: `product "${product.id}" snapshots are not in global registry order; preserve catalog.snapshots ordering`,
        });
      }
      previousRegistryIndex = registered.index;

      for (const field of ['slug', 'label', 'default'] as const) {
        if (snapshot[field] !== registered.snapshot[field]) {
          issues.push({
            path: [...path, field],
            message: `product "${product.id}" snapshot "${snapshot.id}" has ${field} metadata that differs from catalog.snapshots; copy the global value`,
          });
        }
      }
    });
  });

  return issues;
}

const contentCatalogBaseSchema = z.object({
  /** Raw Markdown from the top-level OpenAPI `info.description`. */
  description: z.string().optional(),
  /** Organization-wide snapshot registry used by site-level selectors. */
  snapshots: z.array(contentCatalogSnapshotBaseSchema),
  /** Products with sparse, snapshot-owned section and operation trees. */
  products: z.array(contentCatalogProductSchema),
});

/** Compact, route-neutral global registry plus sparse product snapshot trees. */
export const contentCatalogSchema = contentCatalogBaseSchema.superRefine((catalog, context) => {
  for (const issue of catalogSnapshotIssues(catalog)) context.addIssue({ code: 'custom', ...issue });
});
/** Compact project catalog used to plan routes without loading operation artifacts. */
export type FernContentCatalogSchema = z.infer<typeof contentCatalogSchema>;

/** Compact catalog whose snapshot-owned operations point at exact content-addressed artifacts. */
export const contentArtifactCatalogSchema = contentCatalogBaseSchema
  .extend({ products: z.array(contentArtifactCatalogProductSchema) })
  .superRefine((catalog, context) => {
    for (const issue of catalogSnapshotIssues(catalog)) context.addIssue({ code: 'custom', ...issue });
  });
export type FernContentArtifactCatalogSchema = z.infer<typeof contentArtifactCatalogSchema>;

/** Immutable descriptor whose byte digest is the project revision. */
export const contentArtifactDescriptorSchema = z.object({
  format: z.literal(FERN_ARTIFACT_FORMAT_VERSION),
  /** Loader-rendered top-level OpenAPI description for human-facing surfaces. */
  description: richTextSchema.optional(),
  catalog: contentArtifactCatalogSchema,
});
export type FernContentArtifactDescriptorSchema = z.infer<typeof contentArtifactDescriptorSchema>;

/** Singleton eager content entry containing the catalog and its generation revision. */
export const contentProjectEntrySchema = z.object({
  kind: z.literal('project'),
  id: z.string(),
  revision: fernArtifactDigestSchema,
  ...contentArtifactDescriptorSchema.shape,
});
/** Parsed singleton project entry from the `apiReference` collection. */
export type FernContentProjectEntrySchema = z.infer<typeof contentProjectEntrySchema>;

/** Enriched operation entry loaded individually from a static artifact. */
export const contentOperationEntrySchema = z.object({
  format: z.literal(FERN_ARTIFACT_FORMAT_VERSION),
  kind: z.literal('operation'),
  id: z.string(),
  product: z.object({ id: z.string(), slug: z.string(), title: z.string(), description: z.string() }),
  section: z.object({ id: z.string(), tag: z.string(), title: z.string() }),
  operation: renderedOperationSchema,
  snippets: z.array(contentSnippetSchema),
});
/** Parsed lazy operation entry addressed by its exact serialized bytes. */
export type FernContentOperationEntrySchema = z.infer<typeof contentOperationEntrySchema>;

/** Operation payload before it has been serialized and addressed. */
export const contentOperationPayloadSchema = contentOperationEntrySchema;
export type FernContentOperationPayloadSchema = z.infer<typeof contentOperationPayloadSchema>;

/** Immutable static artifact carrying its serialization format. */
export const contentOperationArtifactSchema = contentOperationEntrySchema;
/** Parsed immutable operation artifact published for lazy loading. */
export type FernContentOperationArtifactSchema = z.infer<typeof contentOperationArtifactSchema>;

/** Union retained as the shared schema for catalog entries and live operation data. */
export const apiReferenceEntrySchema = z.discriminatedUnion('kind', [
  contentProjectEntrySchema,
  contentOperationEntrySchema,
]);
export type FernContentEntrySchema = z.infer<typeof apiReferenceEntrySchema>;

//#endregion
