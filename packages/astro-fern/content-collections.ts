/** Astro loader for a compact catalog plus immutable, route-neutral operation artifacts. */
import type { Loader, LoaderContext } from 'astro/loaders';
import { fileURLToPath } from 'node:url';
import {
  pruneFernOperationArtifacts,
  publishFernOperationArtifacts,
  type FernArtifactGeneration,
  type FernOperationArtifactPublication,
} from './artifacts.ts';
import type {
  DocOperation,
  OperationResponse,
  RequestBody,
  ResponseExample,
  ResponseRepresentation,
  SchemaNode,
} from './content/model.ts';
import {
  contentArtifactCatalogSchema,
  contentArtifactDescriptorSchema,
  contentOperationArtifactSchema,
  contentProjectEntrySchema,
  type FernContentOperationEntrySchema,
  type FernContentOperationPayloadSchema,
  type RenderedOperationResponseSchema,
  type RenderedOperationSchema,
  type RenderedRequestBodySchema,
  type RenderedResponseExampleSchema,
  type RenderedResponseRepresentationSchema,
  type RenderedSchemaNodeSchema,
  type RichTextSchema,
} from './content/schema.ts';
import {
  fernArtifactDigest,
  FERN_ARTIFACT_FORMAT_VERSION,
  FERN_PROJECT_ENTRY_ID,
  serializeFernArtifact,
} from './content-contract.ts';
import {
  buildFernContent,
  type FernContentOptions,
  type FernProjectOptions,
  type FernSource,
  type FernSourceOperation,
  type FernSourceProvider,
  isFernSnapshotSources,
} from './project.ts';

/** Renders Markdown once through Astro's configured Markdown pipeline. */
export type MarkdownRenderer = (markdown: string) => Promise<RichTextSchema>;

async function enrichSchemaNode(node: SchemaNode, render: MarkdownRenderer): Promise<RenderedSchemaNodeSchema> {
  const out: RenderedSchemaNodeSchema = { type: node.type, required: node.required };
  if (node.name !== undefined) out.name = node.name;
  if (node.sdkName !== undefined) out.sdkName = node.sdkName;
  if (node.title !== undefined) out.title = node.title;
  if (node.format !== undefined) out.format = node.format;
  if (node.description) out.description = await render(node.description);
  if (node.enumValues) out.enumValues = node.enumValues;
  if (node.enumValueMetadata) {
    out.enumValueMetadata = await Promise.all(
      node.enumValueMetadata.map(async (metadata) => ({
        value: metadata.value,
        ...(metadata.description ? { description: await render(metadata.description) } : {}),
        ...(metadata.deprecated ? { deprecated: true } : {}),
      })),
    );
  }
  if (node.default !== undefined) out.default = node.default;
  if (node.deprecated) out.deprecated = node.deprecated;
  if (node.children) out.children = await Promise.all(node.children.map((child) => enrichSchemaNode(child, render)));
  if (node.items) out.items = await enrichSchemaNode(node.items, render);
  if (node.variants)
    out.variants = await Promise.all(node.variants.map((variant) => enrichSchemaNode(variant, render)));
  if (node.apiFieldPath) out.apiFieldPath = node.apiFieldPath;
  return out;
}

async function enrichNullableNode(
  node: SchemaNode | null,
  render: MarkdownRenderer,
): Promise<RenderedSchemaNodeSchema | null> {
  return node ? enrichSchemaNode(node, render) : null;
}

async function enrichRequestBody(body: RequestBody, render: MarkdownRenderer): Promise<RenderedRequestBodySchema> {
  const [description, representations] = await Promise.all([
    body.description ? render(body.description) : undefined,
    Promise.all(
      body.representations.map(async (representation) => ({
        mediaType: representation.mediaType,
        schema: await enrichNullableNode(representation.schema, render),
      })),
    ),
  ]);
  return {
    required: body.required,
    ...(description ? { description } : {}),
    representations,
  };
}

async function enrichResponseExample(
  example: ResponseExample,
  render: MarkdownRenderer,
): Promise<RenderedResponseExampleSchema> {
  const out: RenderedResponseExampleSchema = {};
  if (example.name !== undefined) out.name = example.name;
  if (example.summary !== undefined) out.summary = example.summary;
  if (example.description !== undefined) out.description = await render(example.description);
  if (example.value !== undefined) out.value = example.value;
  if (example.externalValue !== undefined) out.externalValue = example.externalValue;
  return out;
}

async function enrichResponseRepresentation(
  representation: ResponseRepresentation,
  render: MarkdownRenderer,
): Promise<RenderedResponseRepresentationSchema> {
  const [schema, examples] = await Promise.all([
    enrichNullableNode(representation.schema, render),
    Promise.all(representation.examples.map((example) => enrichResponseExample(example, render))),
  ]);
  const out: RenderedResponseRepresentationSchema = { mediaType: representation.mediaType, schema, examples };
  if (representation.payloadKey !== undefined) out.payloadKey = representation.payloadKey;
  if (representation.generatedExample !== undefined) out.generatedExample = representation.generatedExample;
  return out;
}

async function enrichResponse(
  response: OperationResponse,
  render: MarkdownRenderer,
): Promise<RenderedOperationResponseSchema> {
  const [description, representations] = await Promise.all([
    render(response.description),
    Promise.all(response.representations.map((representation) => enrichResponseRepresentation(representation, render))),
  ]);
  return { status: response.status, description, representations };
}

export async function enrichOperation(
  operation: DocOperation,
  render: MarkdownRenderer,
): Promise<RenderedOperationSchema> {
  const [description, pathParams, queryParams, requestBody, responses] = await Promise.all([
    render(operation.description),
    Promise.all(operation.pathParams.map((node) => enrichSchemaNode(node, render))),
    Promise.all(operation.queryParams.map((node) => enrichSchemaNode(node, render))),
    operation.requestBody ? enrichRequestBody(operation.requestBody, render) : null,
    Promise.all(operation.responses.map((response) => enrichResponse(response, render))),
  ]);
  const out: RenderedOperationSchema = {
    operationId: operation.operationId,
    slug: operation.slug,
    ...(operation.placement ? { placement: operation.placement } : {}),
    title: operation.title,
    httpMethod: operation.httpMethod,
    path: operation.path,
    description,
    deprecated: operation.deprecated,
    extensions: operation.extensions,
    examples: operation.examples ?? [],
    pathParams,
    queryParams,
    requestBody,
    responses,
  };
  if (operation.availability) out.availability = operation.availability;
  if (operation.requireConfirmation) out.requireConfirmation = operation.requireConfirmation;
  return out;
}

export async function enrichOperationEntry(
  source: FernSourceOperation,
  render: MarkdownRenderer,
): Promise<FernContentOperationEntrySchema> {
  return enrichOperationArtifact(source, render);
}

/** Builds the immutable operation payload written outside Astro's eager content store. */
export async function enrichOperationArtifact(
  source: FernSourceOperation,
  render: MarkdownRenderer,
): Promise<FernContentOperationPayloadSchema> {
  return {
    format: FERN_ARTIFACT_FORMAT_VERSION,
    kind: 'operation',
    id: source.id,
    product: source.product,
    section: source.section,
    operation: await enrichOperation(source.operation, render),
    snippets: source.snippets,
  };
}

/** Markdown that a sanitizing renderer must not emit as live HTML or as a `javascript:` link. */
const SANITIZER_PROBE = '<i data-astro-fern-probe></i> [probe](javascript:probe)';

/**
 * OpenAPI descriptions are untrusted. Rendering them with a processor that
 * passes raw HTML or unsafe URLs through would publish live markup, so fail the
 * build instead. Other integrations can replace or wrap Astro's processor after
 * `astroFern()` installs its sanitizer, so verify the renderer actually in use.
 */
export async function assertSanitizedMarkdownRenderer(renderMarkdown: LoaderContext['renderMarkdown']): Promise<void> {
  const { html } = await renderMarkdown(SANITIZER_PROBE);
  if (/<i\b[^>]*data-astro-fern-probe/i.test(html) || /href\s*=\s*["']?\s*javascript:/i.test(html)) {
    throw new Error(
      'astro-fern: the active Markdown processor renders raw HTML or unsafe URLs from OpenAPI descriptions. Add `sanitizeFernMarkdownPlugin` to the MDAST plugins of the processor Astro uses for content (for example through the option of the integration that configures it).',
    );
  }
}

function cachedRenderer(renderMarkdown: LoaderContext['renderMarkdown']): MarkdownRenderer {
  const cache = new Map<string, RichTextSchema>();
  return async (markdown: string): Promise<RichTextSchema> => {
    const hit = cache.get(markdown);
    if (hit) return hit;
    const { html } = await renderMarkdown(markdown);
    const rich: RichTextSchema = { markdown, html };
    cache.set(markdown, rich);
    return rich;
  };
}

async function sourceForContext(
  source: FernContentOptions['source'],
  root: URL,
): Promise<FernProjectOptions['source']> {
  const providerSources = new Map<FernSourceProvider, Promise<FernSource>>();
  const resolve = (candidate: FernSource | FernSourceProvider): Promise<FernSource> => {
    if (typeof candidate !== 'function') return resolveSourceForContext(candidate, root);
    const existing = providerSources.get(candidate);
    if (existing) return existing;
    const pending = resolveSourceForContext(candidate, root);
    providerSources.set(candidate, pending);
    return pending;
  };

  if (isFernSnapshotSources(source)) {
    const snapshots = await Promise.all(
      source.snapshots.map(async (snapshot) => ({
        ...snapshot,
        source: await resolve(snapshot.source),
      })),
    );
    return { kind: 'snapshots', snapshots };
  }
  return resolve(source);
}

async function resolveSourceForContext(source: FernSource | FernSourceProvider, root: URL): Promise<FernSource> {
  const resolved = typeof source === 'function' ? await source() : source;
  return typeof resolved === 'string' ? new URL(resolved, root) : resolved;
}

function watchedSources(source: FernContentOptions['source'], root: URL): string[] {
  if (isFernSnapshotSources(source)) {
    return source.snapshots.flatMap((snapshot) => watchedSources(snapshot.source, root));
  }
  if (typeof source === 'function') return [];
  const resolved = typeof source === 'string' ? new URL(source, root) : source;
  return resolved instanceof URL && resolved.protocol === 'file:' ? [fileURLToPath(resolved)] : [];
}

function operationSnapshotKey(snapshotId: string, entryId: string): string {
  return `${snapshotId.length}:${snapshotId}${entryId.length}:${entryId}`;
}

function operationArtifactKey(entryId: string, digest: string): string {
  return `${entryId.length}:${entryId}${digest}`;
}

/** The Astro loader capabilities used by one atomic multi-snapshot Fern content generation. */
export type FernContentLoadContext = Pick<LoaderContext, 'parseData' | 'renderMarkdown'> & {
  config: Pick<LoaderContext['config'], 'publicDir' | 'root'>;
  store: Pick<LoaderContext['store'], 'clear' | 'get' | 'set'>;
  logger: Pick<LoaderContext['logger'], 'fork' | 'info'>;
  publishArtifacts?: (generation: FernArtifactGeneration) => Promise<void>;
};

/** The additional capabilities used to coordinate loader rebuilds and file watching. */
export type FernContentLoaderContext = Omit<FernContentLoadContext, 'logger'> & {
  logger: Pick<LoaderContext['logger'], 'error' | 'fork' | 'info'>;
  watcher?: Pick<NonNullable<LoaderContext['watcher']>, 'add' | 'off' | 'on'>;
};

/** Builds, validates, deduplicates, and atomically publishes one complete snapshot generation. */
export async function loadFernContent(options: FernContentOptions, context: FernContentLoadContext): Promise<void> {
  const source = await sourceForContext(options.source, context.config.root);
  const content = buildFernContent({ ...options, source }, { logger: context.logger });
  await assertSanitizedMarkdownRenderer(context.renderMarkdown);
  const render = cachedRenderer(context.renderMarkdown);
  const description = content.catalog.description !== undefined ? await render(content.catalog.description) : undefined;
  const operationPublications = new Map<string, FernOperationArtifactPublication>();
  const artifactDigests = new Map<string, string>();
  for (const source of content.operations) {
    const artifact = contentOperationArtifactSchema.parse(await enrichOperationArtifact(source, render));
    const bytes = serializeFernArtifact(artifact);
    const digest = await fernArtifactDigest(bytes);
    const snapshotKey = operationSnapshotKey(source.snapshotId, artifact.id);
    if (artifactDigests.has(snapshotKey)) {
      throw new Error(
        `astro-fern: snapshot "${source.snapshotId}" generated operation entry "${artifact.id}" more than once; ensure that operation belongs to only one section and product projection in that snapshot`,
      );
    }
    artifactDigests.set(snapshotKey, digest);
    operationPublications.set(operationArtifactKey(artifact.id, digest), { id: artifact.id, digest, bytes });
  }

  const referencedArtifacts = new Set<string>();
  const catalog = contentArtifactCatalogSchema.parse({
    ...content.catalog,
    products: content.catalog.products.map((product) => ({
      ...product,
      snapshots: product.snapshots.map((snapshot) => ({
        ...snapshot,
        sections: snapshot.sections.map((section) => ({
          ...section,
          operations: section.operations.map((operation) => {
            const snapshotKey = operationSnapshotKey(snapshot.id, operation.entryId);
            const artifactDigest = artifactDigests.get(snapshotKey);
            if (!artifactDigest) {
              throw new Error(
                `astro-fern: snapshot "${snapshot.id}" references operation entry "${operation.entryId}" without generated artifact bytes; rebuild the catalog and operations from the same snapshot source set`,
              );
            }
            referencedArtifacts.add(snapshotKey);
            return { ...operation, artifactDigest };
          }),
        })),
      })),
    })),
  });
  if (referencedArtifacts.size !== artifactDigests.size) {
    throw new Error(
      'astro-fern: generated operation artifacts and catalog references are out of sync; rebuild both in one content-loader run and report this as an astro-fern bug if it persists',
    );
  }

  const descriptor = contentArtifactDescriptorSchema.parse({
    format: FERN_ARTIFACT_FORMAT_VERSION,
    ...(description !== undefined ? { description } : {}),
    catalog,
  });
  const descriptorBytes = serializeFernArtifact(descriptor);
  const revision = await fernArtifactDigest(descriptorBytes);
  const project = await context.parseData({
    id: FERN_PROJECT_ENTRY_ID,
    data: {
      kind: 'project',
      id: FERN_PROJECT_ENTRY_ID,
      revision,
      ...descriptor,
    },
  });
  const operations = [...operationPublications.values()];
  const generation: FernArtifactGeneration = { revision, descriptorBytes, operations };

  await (
    context.publishArtifacts ??
    ((nextGeneration) => publishFernOperationArtifacts(context.config.publicDir, nextGeneration))
  )(generation);

  const previousEntry = context.store.get(FERN_PROJECT_ENTRY_ID);
  const previousProject = previousEntry ? contentProjectEntrySchema.safeParse(previousEntry.data) : undefined;
  const previousRevision = previousProject?.success ? previousProject.data.revision : undefined;
  context.store.clear();
  context.store.set({ id: FERN_PROJECT_ENTRY_ID, data: project, digest: revision });
  if (!context.publishArtifacts) {
    try {
      await pruneFernOperationArtifacts(context.config.publicDir, revision, previousRevision);
    } catch (error) {
      context.logger.fork('artifacts').warn(`Could not remove superseded operation artifacts: ${String(error)}`);
    }
  }
  context.logger.info(
    `Loaded ${content.operations.length} operation snapshot(s) as ${operations.length} unique artifact(s)`,
  );
}

/**
 * One loader compiles and validates the catalog and artifacts together, then
 * replaces the project index only after the new artifact generation exists.
 */
export function fernContentLoader(options: FernContentOptions) {
  let latestContext: FernContentLoaderContext | undefined;
  let activeBuild: Promise<void> | undefined;
  let rebuildRequested = false;
  let sourcePaths = new Set<string>();

  const scheduleBuild = async (context: FernContentLoaderContext, initial: boolean): Promise<void> => {
    latestContext = context;
    if (activeBuild) {
      rebuildRequested = true;
      return activeBuild;
    }
    activeBuild = (async () => {
      do {
        rebuildRequested = false;
        try {
          await loadFernContent(options, latestContext ?? context);
        } catch (error) {
          if (initial) throw error;
          const reason = error instanceof Error ? error.message : String(error);
          (latestContext ?? context).logger.error(`Failed to reload Fern content: ${reason}`);
        }
      } while (rebuildRequested);
    })().finally(() => {
      activeBuild = undefined;
    });
    return activeBuild;
  };

  const onSourceChange = (changedPath: string) => {
    if (sourcePaths.has(changedPath) && latestContext) void scheduleBuild(latestContext, false);
  };

  return {
    name: 'astro-fern:content',
    schema: contentProjectEntrySchema,
    load: async (context: FernContentLoaderContext) => {
      latestContext = context;
      sourcePaths = new Set(watchedSources(options.source, context.config.root));
      if (sourcePaths.size > 0 && context.watcher) {
        for (const sourcePath of sourcePaths) context.watcher.add(sourcePath);
        for (const event of ['add', 'change', 'unlink'] as const) {
          context.watcher.off(event, onSourceChange);
          context.watcher.on(event, onSourceChange);
        }
      }
      await scheduleBuild(context, true);
    },
  } satisfies Loader;
}
