import type { OpenApiDocumentSchema, OperationSchema } from './content/openapi.ts';
import {
  buildDocsModelResult,
  discoverFernProductsWithPrepared,
  type FernOperationRoutingPreferenceContext,
  loadOpenApiDocument,
  parseOpenApiDocument,
} from './content/build.ts';
import type { DocOperation } from './content/model.ts';
import type { FernContentCatalogSchema, FernContentSnippetSchema } from './content/schema.ts';
import { prepareFernExtensions, type FernExtensionDefinition, type PreparedFernExtension } from './extensions.ts';
import type { FernExtensionLogger } from './extensions.ts';
import { defineFernManifest, type FernManifest, type FernProductConfig, type FernTargetConfig } from './manifest.ts';
import type { SnippetProvider } from './snippets/index.ts';

/** Helpers available while deriving a manifest from the prepared OpenAPI source set. */
export interface FernManifestProviderContext {
  /** Discovers the union of products and sections across all prepared snapshot sources. */
  discoverProducts(): FernProductConfig[];
}

/** Creates a manifest from the default OpenAPI snapshot and extension-aware helpers. */
export type FernManifestProvider = (
  source: OpenApiDocumentSchema,
  context: FernManifestProviderContext,
) => FernManifest;

/** Parsed OpenAPI input or local JSON source accepted by synchronous project builders. */
export type FernSource = OpenApiDocumentSchema | string | URL;

/** Lazily resolves OpenAPI input for the asynchronous Astro content loader. */
export type FernSourceProvider = () => FernSource | Promise<FernSource>;

/** One documentation snapshot and the exact OpenAPI source that describes it. */
export interface FernSnapshotSource<TSource = FernSource> {
  /** Stable snapshot identity. */
  id: string;
  /** OpenAPI source for this documentation snapshot. */
  source: TSource;
  /** Public URL segment. Defaults to `id`. */
  slug?: string;
  /** Human-facing label. Defaults to `id`. */
  label?: string;
  /** Serves this snapshot without its slug. The first snapshot is the fallback default. */
  default?: boolean;
  /** Replaces product- or manifest-level execution targets for this snapshot. */
  targets?: FernTargetConfig[];
}

/** Explicit multi-source mode for independently generated documentation snapshots. */
export interface FernSnapshotSources<TSource = FernSource> {
  kind: 'snapshots';
  /** Snapshot registry in display order. */
  snapshots: readonly FernSnapshotSource<TSource>[];
}

/** Synchronous input: one shared OpenAPI source or exact snapshot bindings. */
export type FernProjectSource = FernSource | FernSnapshotSources<FernSource>;
/** Loader input, where a shared source or each bound snapshot may be resolved asynchronously. */
export type FernContentSource = FernSource | FernSourceProvider | FernSnapshotSources<FernSource | FernSourceProvider>;

/** Inputs and consumer policies used to build route-neutral shared or snapshot Fern content. */
export interface FernProjectOptions {
  /** One shared OpenAPI source, or explicit documentation snapshots and their exact sources. */
  source: FernProjectSource;
  /** Static manifest or callback derived from the default source; discovery spans all snapshots. */
  manifest: FernManifest | FernManifestProvider;
  /** Identifier to display-label formatter. */
  formatIdentifier?: (identifier: string) => string;
  /** Renders per-operation code samples for configured targets. */
  snippets?: SnippetProvider;
  /** Consumer-owned visibility policy. */
  isOperationHidden?: (operation: OperationSchema) => boolean;
  /** Secondary SDK collision preference applied only after extension routing priority. */
  operationRoutingPreference?: (context: FernOperationRoutingPreferenceContext) => number | undefined;
  /** Response envelope key to unwrap, such as Cloudflare's `result`. */
  responsePayloadKey?: string;
  /** Synchronous extensions prepared independently for each source document. */
  extensions?: readonly FernExtensionDefinition[];
  /** Receives recoverable build diagnostics. */
  onWarning?: (message: string) => void;
}

/** Content-loader options, including sources that require asynchronous resolution. */
export type FernContentOptions = Omit<FernProjectOptions, 'source'> & {
  source: FernContentSource;
};

/** One snapshot-specific raw-Markdown operation produced before artifact enrichment. */
export interface FernSourceOperation {
  /** Stable semantic identity derived from product ID and OpenAPI operation ID. */
  id: string;
  /** Snapshot that references this operation payload. */
  snapshotId: string;
  product: { id: string; slug: string; title: string; description: string };
  section: { id: string; tag: string; title: string };
  operation: DocOperation;
  snippets: FernContentSnippetSchema[];
}

/** Route-neutral global catalog and snapshot-specific operations. */
export interface FernContentProjectData {
  catalog: FernContentCatalogSchema;
  operations: FernSourceOperation[];
}

/** Lazily memoized, synchronous builder returned by {@link defineFernProject}. */
export interface FernProject {
  /** Original options object retained by this builder. */
  readonly options: FernProjectOptions;
  /** Builds once and returns the global catalog plus exact route-neutral operation snapshots. */
  getData(): FernContentProjectData;
}

/** A snapshot resolved for content identity; mounted URLs are composed later. */
type ResolvedSnapshot<TSource> = Omit<FernSnapshotSource<TSource>, 'slug' | 'label' | 'default'> & {
  slug: string;
  label: string;
  default: boolean;
};

function resolveSnapshots(source: FernProjectSource): {
  explicit: boolean;
  snapshots: ResolvedSnapshot<FernSource>[];
} {
  if (!isFernSnapshotSources(source)) {
    return {
      explicit: false,
      snapshots: [{ id: 'current', slug: 'current', label: 'Current', default: true, source }],
    };
  }
  if (source.snapshots.length === 0) {
    throw new Error('astro-fern: snapshot source set is empty; add at least one { id, source } snapshot');
  }

  const explicitDefaults = source.snapshots.filter((snapshot) => snapshot.default);
  if (explicitDefaults.length > 1) {
    throw new Error('astro-fern: snapshot source set has more than one default snapshot');
  }
  const defaultId = explicitDefaults[0]?.id ?? source.snapshots[0]?.id;
  const ids = new Set<string>();
  const slugs = new Set<string>();
  const snapshots = source.snapshots.map((snapshot, index): ResolvedSnapshot<FernSource> => {
    if (!snapshot.id.trim()) {
      throw new Error(`astro-fern: snapshot at index ${index} has an empty ID`);
    }
    if (ids.has(snapshot.id)) {
      throw new Error(`astro-fern: duplicate snapshot ID "${snapshot.id}"; keep one source entry per snapshot`);
    }
    ids.add(snapshot.id);
    const slug = snapshot.slug ?? snapshot.id;
    if (!slug || slug.includes('/') || slug === '.' || slug === '..') {
      throw new Error(
        `astro-fern: snapshot "${snapshot.id}" has an invalid URL slug "${slug}" (must be non-empty, contain no "/", and not be "." or "..")`,
      );
    }
    if (slugs.has(slug)) {
      throw new Error(`astro-fern: duplicate snapshot URL slug "${slug}"; give every snapshot a distinct slug`);
    }
    slugs.add(slug);

    const targetIds = new Set<string>();
    for (const target of snapshot.targets ?? []) {
      if (!target.id) throw new Error(`astro-fern: snapshot "${snapshot.id}" target IDs must not be empty`);
      if (targetIds.has(target.id)) {
        throw new Error(`astro-fern: duplicate snapshot "${snapshot.id}" target ID "${target.id}"`);
      }
      targetIds.add(target.id);
    }
    return {
      ...snapshot,
      slug,
      label: snapshot.label ?? snapshot.id,
      default: snapshot.id === defaultId,
    };
  });
  return { explicit: true, snapshots };
}

function targetsFor(
  manifest: FernManifest,
  product: FernProductConfig,
  snapshot: ResolvedSnapshot<FernSource>,
): FernTargetConfig[] {
  return snapshot.targets ?? product.targets ?? manifest.targets ?? [];
}

function globalTargetsFor(manifest: FernManifest, snapshot: ResolvedSnapshot<FernSource>): FernTargetConfig[] {
  return snapshot.targets ?? manifest.targets ?? [];
}

function operationEntryId(product: string, operationId: string, projectionId: string): string {
  return `operation:${[product, operationId, projectionId].map((value) => `${value.length}:${value}`).join('')}`;
}

/** Optional build services supplied by an Astro content loader. */
export interface FernProjectBuildContext {
  logger?: { fork(label: string): FernExtensionLogger };
}

/** True when a source uses explicit snapshot bindings. */
export function isFernSnapshotSources<TSource>(
  source: TSource | FernSnapshotSources<TSource>,
): source is FernSnapshotSources<TSource> {
  if (!source || typeof source !== 'object') return false;
  const candidate = source as Partial<FernSnapshotSources<TSource>>;
  return candidate.kind === 'snapshots' && Array.isArray(candidate.snapshots);
}

interface PreparedSource {
  source: OpenApiDocumentSchema;
  extensions: readonly PreparedFernExtension[];
}

function parsedSource(source: FernSource): OpenApiDocumentSchema {
  return typeof source === 'string' || source instanceof URL
    ? loadOpenApiDocument(source)
    : parseOpenApiDocument(source);
}

function prepareSource(
  source: FernSource,
  extensions: readonly FernExtensionDefinition[],
  logger: FernProjectBuildContext['logger'],
  label?: string,
): PreparedSource {
  const parsed = parsedSource(source);
  const scopedLogger = label && logger ? { fork: (name: string) => logger.fork(`${label}:${name}`) } : logger;
  return { source: parsed, extensions: prepareFernExtensions(extensions, parsed, scopedLogger) };
}

function discoverProductsFromSources(sources: readonly PreparedSource[]): FernProductConfig[] {
  const products = new Map<string, FernProductConfig>();
  for (const prepared of sources) {
    for (const discovered of discoverFernProductsWithPrepared(prepared.source, prepared.extensions)) {
      const existing = products.get(discovered.id);
      if (!existing) {
        products.set(discovered.id, { ...discovered, sections: [...discovered.sections] });
        continue;
      }
      const sections = new Map(existing.sections.map((section) => [section.id, section]));
      for (const section of discovered.sections) {
        const current = sections.get(section.id);
        if (current && current.tag !== section.tag) {
          throw new Error(
            `astro-fern: section "${discovered.id}.${section.id}" resolves to both OpenAPI tag "${current.tag}" and "${section.tag}" across snapshots; keep the tag stable for that section ID or assign the changed tag a distinct section ID`,
          );
        }
        sections.set(section.id, section);
      }
      existing.sections = [...sections.values()].sort((left, right) => left.tag.localeCompare(right.tag));
    }
  }
  return [...products.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** Builds a global snapshot registry and exact route-neutral content without mounted paths. */
export function buildFernContent(
  options: FernProjectOptions,
  context: FernProjectBuildContext = {},
): FernContentProjectData {
  const extensions = options.extensions ?? [];
  const resolved = resolveSnapshots(options.source);
  const groups = resolved.snapshots.map((snapshot) => ({
    snapshot,
    prepared: prepareSource(
      snapshot.source,
      extensions,
      context.logger,
      resolved.explicit ? `snapshot:${snapshot.id}` : undefined,
    ),
  }));
  const defaultGroup = groups.find((group) => group.snapshot.default);
  if (!defaultGroup) throw new Error('astro-fern: resolved snapshot set has no default');

  const manifest = defineFernManifest(
    typeof options.manifest === 'function'
      ? options.manifest(defaultGroup.prepared.source, {
          discoverProducts: () => discoverProductsFromSources(groups.map((group) => group.prepared)),
        })
      : options.manifest,
  );

  const operations: FernSourceOperation[] = [];
  const products = new Map<string, FernContentCatalogSchema['products'][number]>();
  const matchedSections = new Set<string>();
  let description: string | undefined;
  const buildLogger = context.logger?.fork('astro:fern-routing');

  for (const group of groups) {
    const result = buildDocsModelResult(
      {
        source: group.prepared.source,
        products: manifest.products,
        ...(options.formatIdentifier ? { formatIdentifier: options.formatIdentifier } : {}),
        ...(options.snippets ? { snippets: options.snippets } : {}),
        ...(options.snippets ? { snippetSnapshotIds: [group.snapshot.id] } : {}),
        ...(options.isOperationHidden ? { isOperationHidden: options.isOperationHidden } : {}),
        ...(options.operationRoutingPreference
          ? { operationRoutingPreference: options.operationRoutingPreference }
          : {}),
        ...(options.responsePayloadKey ? { responsePayloadKey: options.responsePayloadKey } : {}),
        ...(options.extensions ? { extensions: options.extensions } : {}),
        ...(options.onWarning
          ? { onWarning: options.onWarning }
          : buildLogger
            ? { onWarning: (message: string) => buildLogger.warn(message) }
            : {}),
        ...(resolved.explicit ? { allowMissingSections: true } : {}),
      },
      group.prepared.extensions,
    );
    for (const section of result.matchedSections) matchedSections.add(section);
    if (group.snapshot.default) description = result.model.description;

    for (const productConfig of manifest.products) {
      const modelProduct = result.model.products.find((product) => product.name === productConfig.id);
      if (!modelProduct) continue;
      const title = productConfig.title ?? modelProduct.title;
      const productDescription = productConfig.description ?? modelProduct.description;
      const productSlug = modelProduct.slug;
      const sections: FernContentCatalogSchema['products'][number]['snapshots'][number]['sections'] = [];

      for (const modelSection of modelProduct.sections) {
        const section = { id: modelSection.id, tag: modelSection.tag, title: modelSection.title };
        const operationRefs: (typeof sections)[number]['operations'] = [];
        for (const operation of modelSection.operations) {
          const entryId = operationEntryId(
            productConfig.id,
            operation.operationId,
            operation.placement?.projectionId ?? 'primary',
          );
          operationRefs.push({
            entryId,
            operationId: operation.operationId,
            slug: operation.slug,
            ...(operation.placement ? { placement: operation.placement } : {}),
            title: operation.title,
            description: operation.description,
            httpMethod: operation.httpMethod,
          });
          operations.push({
            id: entryId,
            snapshotId: group.snapshot.id,
            product: { id: productConfig.id, slug: productSlug, title, description: productDescription },
            section,
            operation,
            snippets: operation.snippets
              .filter((snippet) => snippet.snapshotId === undefined || snippet.snapshotId === group.snapshot.id)
              .map(({ targetId, code, syntax }) => ({ targetId, code, syntax })),
          });
        }
        sections.push({ ...section, operations: operationRefs });
      }

      let product = products.get(productConfig.id);
      if (!product) {
        product = { id: productConfig.id, slug: productSlug, title, description: productDescription, snapshots: [] };
        products.set(productConfig.id, product);
      }
      product.snapshots.push({
        id: group.snapshot.id,
        slug: group.snapshot.slug,
        label: group.snapshot.label,
        default: group.snapshot.default,
        targets: targetsFor(manifest, productConfig, group.snapshot),
        sections,
      });
    }
  }

  if (resolved.explicit) {
    for (const product of manifest.products) {
      for (const section of product.sections) {
        if (!matchedSections.has(`${product.id}\0${section.id}`)) {
          throw new Error(
            `astro-fern: section "${product.id}.${section.id}" matched no operation tagged "${section.tag}" in any snapshot; add that tag to an owned operation in at least one snapshot or remove/correct the manifest section`,
          );
        }
      }
    }
  }

  return {
    catalog: {
      ...(description !== undefined ? { description } : {}),
      snapshots: resolved.snapshots.map((snapshot) => ({
        id: snapshot.id,
        slug: snapshot.slug,
        label: snapshot.label,
        default: snapshot.default,
        targets: globalTargetsFor(manifest, snapshot),
      })),
      products: manifest.products.flatMap((product) => {
        const built = products.get(product.id);
        return built ? [built] : [];
      }),
    },
    operations,
  };
}

/** Lazy content builder used by tests and non-Astro consumers. */
export function defineFernProject(options: FernProjectOptions): FernProject {
  let data: FernContentProjectData | undefined;
  return {
    options,
    getData() {
      data ??= buildFernContent(options);
      return data;
    },
  };
}
