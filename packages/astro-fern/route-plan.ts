import type {
  FernAgentLinksSchema,
  FernContentCatalogSchema,
  FernContentOperationEntrySchema,
  FernExecutionTargetSchema,
  OperationPlacementSchema,
  FernPageSchema,
  RichTextSchema,
} from './content/schema.ts';
import type { FernContentTargetSchema } from './content/schema.ts';
import type { AgentScope, FernRuntimeConfig } from './runtime-config.ts';

export type { FernAgentLinksSchema, FernExecutionTargetSchema, FernPageSchema } from './content/schema.ts';

/** Lightweight operation metadata used for navigation and semantic link resolution. */
export interface FernCatalogPage {
  /** Snapshot-specific page identity. */
  id: string;
  /** Semantic operation identity shared by snapshots of this page. */
  entryId: string;
  /** OpenAPI operation ID. */
  operationId: string;
  /** Canonical human-documentation pathname. */
  pathname: string;
  /** Route-neutral operation slug owned by this snapshot; sibling snapshots may use another slug. */
  slug: string;
  /** SDK resource and method placement for resource-oriented navigation. */
  placement?: OperationPlacementSchema;
  /** Manifest section that owns the operation. */
  section: { id: string; tag: string; title: string };
  /** Human-facing operation title. */
  title: string;
  /** Raw-Markdown operation description used by navigation and agent indexes. */
  description: string;
  /** Uppercase HTTP method. */
  httpMethod: string;
}

/** Organization-wide snapshot metadata used outside any one product. */
export interface FernCatalogSiteSnapshot {
  id: string;
  slug: string;
  label: string;
  default: boolean;
  targets: FernContentTargetSchema[];
}

/** One available product snapshot after URL, target, and page metadata have been resolved. */
export interface FernCatalogSnapshot {
  /** Canonical snapshot identity. */
  id: string;
  /** Public snapshot URL segment. */
  slug: string;
  /** Human-facing snapshot label. */
  label: string;
  /** Whether this snapshot is served without its slug. */
  default: boolean;
  /** Operation pages available in this product snapshot. */
  pages: FernCatalogPage[];
  /** Execution targets available in this product snapshot. */
  targets: FernContentTargetSchema[];
}

/** Product metadata and the subset of global snapshots in which it exists. */
export interface FernCatalogProduct {
  /** Stable product identity. */
  id: string;
  /** Public product URL segment. */
  slug: string;
  /** Human-facing product name. */
  title: string;
  /** Product summary. */
  description: string;
  /** Available snapshots in global registry order; snapshots without this product are absent. */
  snapshots: FernCatalogSnapshot[];
}

/** One mounted human route, including optional execution-target selection. */
export interface FernHumanRoute {
  /** Public pathname including Astro and astro-fern bases. */
  pathname: string;
  /** Catch-all route parameter relative to the astro-fern routing base. */
  slug: string;
  /** Snapshot-specific page rendered by this route. */
  pageId: string;
  /** Selected target for path-based target routes. */
  target?: string;
}

/** Route metadata for a generated operation Markdown document or llms.txt index. */
export interface FernAgentRoute {
  /** Stable route identity consumed by response helpers. */
  id: string;
  /** Public pathname including deployment bases. */
  pathname: string;
  /** Agent document rendered by the route. */
  kind: 'page-markdown' | 'llms-index';
  /** Catch-all route parameter used by Astro static-path helpers. */
  param?: string;
  /** Operation page identity for Markdown routes. */
  pageId?: string;
  /** Execution target selected by a target-specific Markdown route. */
  target?: string;
  /** Semantic llms.txt scope; distinguishes product indexes from their default-snapshot metadata. */
  scopeKind?: AgentScope;
  /** Canonical identities covered by an llms.txt route. */
  scope?: { product?: string; snapshot?: string; target?: string };
}

/** Complete mounted route and navigation plan composed without loading operation artifact bodies. */
export interface FernRoutePlan {
  /** Renderer-facing catalog containing products, snapshots, and lightweight pages. */
  catalog: { description?: RichTextSchema; snapshots: FernCatalogSiteSnapshot[]; products: FernCatalogProduct[] };
  /** Canonical and target-specific human routes. */
  humanRoutes: FernHumanRoute[];
  /** Generated Markdown and llms.txt routes. */
  agentRoutes: FernAgentRoute[];
  /** Resolved routing configuration including deployment base. */
  routing: FernRuntimeConfig['routing'];
  /** Resolved agent-surface configuration. */
  agents: FernRuntimeConfig['agents'];
  /** Canonical site URL used to emit absolute agent links. */
  site?: string;
}

/** Eager project representation containing every composed operation page. */
export interface FernProjectData extends FernRoutePlan {
  /** Fully composed operation pages for every available product snapshot. */
  pages: FernPageSchema[];
}

/** Deployment metadata applied while mounting route-neutral content. */
export interface FernDeploymentConfig {
  /** Astro's deployment base, which prefixes every public route. */
  base?: string;
  /** Astro's canonical site URL, used to make agent links absolute. */
  site?: string;
}

/** Optional rich metadata added to a composed catalog. */
export interface FernCatalogMetadata {
  /** Rendered top-level OpenAPI description. */
  description?: RichTextSchema;
}

/** Alias for the eager project representation consumed by pure renderers. */
export type FernProjectView = FernProjectData;

type ContentProduct = FernContentCatalogSchema['products'][number];
type ContentSnapshot = ContentProduct['snapshots'][number];
type ContentSection = ContentSnapshot['sections'][number];
type ContentOperation = ContentSection['operations'][number];

interface ContentOperationLocation {
  product: ContentProduct;
  section: ContentSection;
  operation: ContentOperation;
  snapshot: ContentSnapshot;
}

const catalogOperationLocations = new WeakMap<FernContentCatalogSchema, Map<string, ContentOperationLocation>>();

interface CompositionConfig {
  runtime: FernRuntimeConfig;
  site: string | undefined;
  siteIndexPath: string;
}

interface PlannedPage {
  pageId: string;
  pathname: string;
  relativeSlug: string;
  snapshotRelative: string;
  snapshot: ContentSnapshot;
  operation: ContentOperation;
}

function joinPath(...segments: string[]): string {
  return `/${segments
    .flatMap((segment) => segment.split('/'))
    .filter(Boolean)
    .join('/')}`;
}

function withTrailingSlash(pathname: string): string {
  return pathname.endsWith('/') ? pathname : `${pathname}/`;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function tupleId(kind: string, ...values: string[]): string {
  return `${kind}:${values.map((value) => `${value.length}:${value}`).join('')}`;
}

function absolute(site: string | undefined, pathname: string): string {
  return site ? new URL(pathname, site).href : pathname;
}

function operationLocations(catalog: FernContentCatalogSchema): Map<string, ContentOperationLocation> {
  const cached = catalogOperationLocations.get(catalog);
  if (cached) return cached;

  const locations = new Map<string, ContentOperationLocation>();
  for (const product of catalog.products) {
    for (const snapshot of product.snapshots) {
      for (const section of snapshot.sections) {
        for (const operation of section.operations) {
          locations.set(tupleId('operation-location', snapshot.id, operation.entryId), {
            product,
            snapshot,
            section,
            operation,
          });
        }
      }
    }
  }
  catalogOperationLocations.set(catalog, locations);
  return locations;
}

function resolveCompositionConfig(
  runtimeConfig: FernRuntimeConfig,
  deployment: FernDeploymentConfig,
): CompositionConfig {
  const deploymentBase = joinPath(deployment.base ?? '/');
  return {
    runtime: {
      ...runtimeConfig,
      routing: {
        ...runtimeConfig.routing,
        base: joinPath(deploymentBase, runtimeConfig.routing.base),
      },
    },
    site: deployment.site,
    siteIndexPath: joinPath(deploymentBase, 'llms.txt'),
  };
}

function targetHref(targetId: string, operationSlug: string, prefix: string, runtime: FernRuntimeConfig): string {
  return runtime.routing.target === 'path'
    ? withTrailingSlash(joinPath(prefix, segment(targetId), operationSlug))
    : `${withTrailingSlash(joinPath(prefix, operationSlug))}#${encodeURIComponent(targetId)}`;
}

function targetsForPage(
  targets: FernContentTargetSchema[],
  operation: FernContentOperationEntrySchema,
  prefix: string,
  relativePrefix: string,
  runtime: FernRuntimeConfig,
  site: string | undefined,
): FernExecutionTargetSchema[] {
  const snippets = new Map(operation.snippets.map((snippet) => [snippet.targetId, snippet]));
  return targets.map((target) => {
    const targetRelative = joinPath(relativePrefix, segment(target.id));
    const href = targetHref(target.id, operation.operation.slug, prefix, runtime);
    const markdownHref = runtime.agents.markdown
      ? absolute(site, `${joinPath(runtime.routing.base, targetRelative, operation.operation.slug)}.md`)
      : undefined;
    const snippet = snippets.get(target.id);
    return {
      ...target,
      code: snippet?.code ?? null,
      syntax: snippet?.syntax ?? target.language,
      href,
      ...(markdownHref ? { markdownHref } : {}),
    };
  });
}

function llmsLinks(
  scopes: AgentScope[],
  base: string,
  siteIndexPath: string,
  productId: string,
  productSlug: string,
  snapshot: { default: boolean; slug: string },
  productHasDefaultSnapshot: boolean,
  site: string | undefined,
): FernAgentLinksSchema['llms'] {
  const productBase = joinPath(base, productSlug);
  const prefix = snapshot.default ? productBase : joinPath(productBase, segment(snapshot.slug));
  const links: FernAgentLinksSchema['llms'] = [];
  if (scopes.includes('site')) links.push({ scope: 'site', href: absolute(site, siteIndexPath) });
  if (scopes.includes('product') && productHasDefaultSnapshot) {
    links.push({ scope: 'product', href: absolute(site, `${productBase}/llms.txt`) });
  }
  if (scopes.includes('snapshot') && (!snapshot.default || !scopes.includes('product'))) {
    links.push({ scope: 'snapshot', href: absolute(site, `${prefix}/llms.txt`) });
  }
  return links;
}

function assertUniqueRoute(routes: Map<string, string>, pathname: string, owner: string): void {
  const key = pathname.replace(/\/+$/, '') || '/';
  const existing = routes.get(key);
  if (existing) {
    throw new Error(`astro-fern: generated route collision at "${pathname}" between ${existing} and ${owner}`);
  }
  routes.set(key, owner);
}

function composePage(
  product: ContentProduct,
  section: ContentSection,
  operationRef: ContentOperation,
  snapshot: ContentSnapshot,
  operation: FernContentOperationEntrySchema,
  config: CompositionConfig,
): FernPageSchema {
  const { runtime, site, siteIndexPath } = config;
  const productRelative = product.slug;
  const productBase = joinPath(runtime.routing.base, productRelative);
  const snapshotRelative = snapshot.default ? productRelative : joinPath(productRelative, segment(snapshot.slug));
  const prefix = snapshot.default ? productBase : joinPath(productBase, segment(snapshot.slug));
  const pathname = withTrailingSlash(joinPath(prefix, operationRef.slug));
  const markdownPath = `${joinPath(prefix, operationRef.slug)}.md`;
  const targets = targetsForPage(snapshot.targets, operation, prefix, snapshotRelative, runtime, site);
  const agentLinks: FernAgentLinksSchema = {
    ...(runtime.agents.markdown
      ? { markdown: { href: absolute(site, markdownPath), mediaType: 'text/markdown' as const } }
      : {}),
    llms:
      runtime.agents.llms === false
        ? []
        : llmsLinks(
            runtime.agents.llms.scopes,
            runtime.routing.base,
            siteIndexPath,
            product.id,
            product.slug,
            snapshot,
            product.snapshots.some((candidate) => candidate.default),
            site,
          ),
  };
  return {
    id: tupleId('page', product.id, snapshot.id, operationRef.entryId),
    entryId: operationRef.entryId,
    pathname,
    product: { id: product.id, slug: product.slug, title: product.title, description: product.description },
    section: { id: section.id, tag: section.tag, title: section.title },
    snapshot: { id: snapshot.id, label: snapshot.label, default: snapshot.default },
    operation: operation.operation,
    targets,
    agentLinks,
  };
}

/** Composes one renderer-facing page from an operation entry and the exact snapshot that references it. */
export function composeFernPage(
  contentCatalog: FernContentCatalogSchema,
  operationEntry: FernContentOperationEntrySchema,
  snapshotId: string,
  runtimeConfig: FernRuntimeConfig,
  deployment: FernDeploymentConfig = {},
): FernPageSchema {
  const location = operationLocations(contentCatalog).get(tupleId('operation-location', snapshotId, operationEntry.id));
  if (!location) {
    throw new Error(
      `astro-fern: operation entry "${operationEntry.id}" is not referenced by snapshot "${snapshotId}"; use page.entryId and its enclosing catalog snapshot's id`,
    );
  }
  return composePage(
    location.product,
    location.section,
    location.operation,
    location.snapshot,
    operationEntry,
    resolveCompositionConfig(runtimeConfig, deployment),
  );
}

/** Plans every public route using only the route-neutral content catalog. */
export function composeFernRoutePlan(
  contentCatalog: FernContentCatalogSchema,
  runtimeConfig: FernRuntimeConfig,
  deployment: FernDeploymentConfig = {},
  metadata: FernCatalogMetadata = {},
): FernRoutePlan {
  const { runtime, site, siteIndexPath } = resolveCompositionConfig(runtimeConfig, deployment);
  const humanRoutes: FernHumanRoute[] = [];
  const catalogProducts: FernCatalogProduct[] = [];
  const routes = new Map<string, string>();
  const plannedPages: PlannedPage[] = [];

  for (const product of contentCatalog.products) {
    const catalogSnapshots: FernCatalogSnapshot[] = [];
    const productRelative = product.slug;
    const productBase = joinPath(runtime.routing.base, productRelative);
    for (const snapshot of product.snapshots) {
      const snapshotRelative = snapshot.default ? productRelative : joinPath(productRelative, segment(snapshot.slug));
      const prefix = snapshot.default ? productBase : joinPath(productBase, segment(snapshot.slug));
      const catalogPages: FernCatalogPage[] = [];
      for (const section of snapshot.sections) {
        for (const operationRef of section.operations) {
          const pageId = tupleId('page', product.id, snapshot.id, operationRef.entryId);
          const relativeSlug = joinPath(snapshotRelative, operationRef.slug).slice(1);
          const pathname = withTrailingSlash(joinPath(prefix, operationRef.slug));
          const canonicalRoute: FernHumanRoute = { pathname, slug: relativeSlug, pageId };
          humanRoutes.push(canonicalRoute);
          assertUniqueRoute(routes, pathname, `operation ${product.id}.${operationRef.operationId}`);
          if (runtime.routing.target === 'path') {
            for (const target of snapshot.targets) {
              const targetSlug = joinPath(snapshotRelative, segment(target.id), operationRef.slug).slice(1);
              const pathname = targetHref(target.id, operationRef.slug, prefix, runtime);
              humanRoutes.push({ pathname, slug: targetSlug, pageId, target: target.id });
              assertUniqueRoute(routes, pathname, `target ${product.id}.${operationRef.operationId}.${target.id}`);
            }
          }
          plannedPages.push({
            pageId,
            pathname,
            relativeSlug,
            snapshotRelative,
            snapshot,
            operation: operationRef,
          });
          catalogPages.push({
            id: pageId,
            entryId: operationRef.entryId,
            operationId: operationRef.operationId,
            pathname,
            slug: operationRef.slug,
            ...(operationRef.placement ? { placement: operationRef.placement } : {}),
            section: { id: section.id, tag: section.tag, title: section.title },
            title: operationRef.title,
            description: operationRef.description,
            httpMethod: operationRef.httpMethod,
          });
        }
      }
      catalogSnapshots.push({ ...snapshot, pages: catalogPages });
    }
    catalogProducts.push({
      id: product.id,
      slug: product.slug,
      title: product.title,
      description: product.description,
      snapshots: catalogSnapshots,
    });
  }

  const agentRoutes: FernAgentRoute[] = [];
  if (runtime.agents.markdown) {
    for (const page of plannedPages) {
      const pathname = `${page.pathname.replace(/\/$/, '')}.md`;
      agentRoutes.push({
        id: tupleId('markdown', page.pageId),
        pathname,
        kind: 'page-markdown',
        param: page.relativeSlug,
        pageId: page.pageId,
      });
      assertUniqueRoute(routes, pathname, `Markdown ${page.pageId}`);
      for (const target of page.snapshot.targets) {
        const targetParam = joinPath(page.snapshotRelative, segment(target.id), page.operation.slug).slice(1);
        const targetPathname = `${joinPath(runtime.routing.base, targetParam)}.md`;
        agentRoutes.push({
          id: tupleId('markdown', page.pageId, target.id),
          pathname: targetPathname,
          kind: 'page-markdown',
          param: targetParam,
          pageId: page.pageId,
          target: target.id,
        });
        assertUniqueRoute(routes, targetPathname, `target Markdown ${page.pageId}.${target.id}`);
      }
    }
  }

  if (runtime.agents.llms !== false) {
    const scopes = runtime.agents.llms.scopes;
    if (scopes.includes('site')) {
      agentRoutes.push({
        id: 'llms:site',
        pathname: siteIndexPath,
        kind: 'llms-index',
        scopeKind: 'site',
        scope: {},
      });
      assertUniqueRoute(routes, siteIndexPath, 'site llms.txt');
    }
    for (const product of catalogProducts) {
      const defaultSnapshot = product.snapshots.find((snapshot) => snapshot.default);
      const productRelative = product.slug;
      if (scopes.includes('product') && defaultSnapshot) {
        const pathname = `${joinPath(runtime.routing.base, productRelative)}/llms.txt`;
        agentRoutes.push({
          id: tupleId('llms-product', product.id),
          pathname,
          kind: 'llms-index',
          param: productRelative,
          scopeKind: 'product',
          scope: { product: product.id, snapshot: defaultSnapshot.id },
        });
        assertUniqueRoute(routes, pathname, `product llms.txt ${product.id}`);
      } else if (scopes.includes('snapshot') && defaultSnapshot) {
        const pathname = `${joinPath(runtime.routing.base, productRelative)}/llms.txt`;
        agentRoutes.push({
          id: tupleId('llms-snapshot', product.id, defaultSnapshot.id),
          pathname,
          kind: 'llms-index',
          param: productRelative,
          scopeKind: 'snapshot',
          scope: { product: product.id, snapshot: defaultSnapshot.id },
        });
        assertUniqueRoute(routes, pathname, `snapshot llms.txt ${product.id}.${defaultSnapshot.id}`);
      }
      for (const snapshot of product.snapshots) {
        const relative = snapshot.default
          ? productRelative
          : joinPath(productRelative, segment(snapshot.slug)).slice(1);
        const prefix = joinPath(runtime.routing.base, relative);
        if (scopes.includes('snapshot') && !snapshot.default) {
          const pathname = `${prefix}/llms.txt`;
          agentRoutes.push({
            id: tupleId('llms-snapshot', product.id, snapshot.id),
            pathname,
            kind: 'llms-index',
            param: relative,
            scopeKind: 'snapshot',
            scope: { product: product.id, snapshot: snapshot.id },
          });
          assertUniqueRoute(routes, pathname, `snapshot llms.txt ${product.id}.${snapshot.id}`);
        }
        if (scopes.includes('target')) {
          for (const target of snapshot.targets) {
            const param = joinPath(relative, 'targets', segment(target.id)).slice(1);
            const pathname = `${joinPath(runtime.routing.base, param)}/llms.txt`;
            agentRoutes.push({
              id: tupleId('llms-target', product.id, snapshot.id, target.id),
              pathname,
              kind: 'llms-index',
              param,
              scopeKind: 'target',
              scope: { product: product.id, snapshot: snapshot.id, target: target.id },
            });
            assertUniqueRoute(routes, pathname, `target llms.txt ${product.id}.${snapshot.id}.${target.id}`);
          }
        }
      }
    }
  }

  return {
    catalog: {
      ...(metadata.description !== undefined ? { description: metadata.description } : {}),
      snapshots: contentCatalog.snapshots,
      products: catalogProducts,
    },
    humanRoutes,
    agentRoutes,
    routing: runtime.routing,
    agents: runtime.agents,
    ...(site ? { site } : {}),
  };
}

/** Exact snapshot identity paired with one enriched operation artifact. */
export interface FernSnapshotOperationEntry {
  /** Canonical snapshot ID that references these operation bytes. */
  snapshotId: string;
  /** Enriched artifact payload for this snapshot and semantic operation ID. */
  operation: FernContentOperationEntrySchema;
}

/** Combines a sparse snapshot catalog and exact snapshot operations with integration-owned routing. */
export function composeFernProject(
  contentCatalog: FernContentCatalogSchema,
  contentOperations: FernSnapshotOperationEntry[],
  runtimeConfig: FernRuntimeConfig,
  deployment: FernDeploymentConfig = {},
  metadata: FernCatalogMetadata = {},
): FernProjectData {
  const plan = composeFernRoutePlan(contentCatalog, runtimeConfig, deployment, metadata);
  const config = resolveCompositionConfig(runtimeConfig, deployment);
  const operationById = new Map(
    contentOperations.map(({ snapshotId, operation }) => [
      tupleId('operation-location', snapshotId, operation.id),
      operation,
    ]),
  );
  const pages: FernPageSchema[] = [];

  for (const product of contentCatalog.products) {
    for (const snapshot of product.snapshots) {
      for (const section of snapshot.sections) {
        for (const operationRef of section.operations) {
          const operation = operationById.get(tupleId('operation-location', snapshot.id, operationRef.entryId));
          if (!operation) {
            throw new Error(
              `astro-fern: snapshot "${snapshot.id}" references operation entry "${operationRef.entryId}" without a matching enriched payload; include { snapshotId: "${snapshot.id}", operation } in contentOperations`,
            );
          }
          pages.push(composePage(product, section, operationRef, snapshot, operation, config));
        }
      }
    }
  }

  return {
    catalog: plan.catalog,
    pages,
    humanRoutes: plan.humanRoutes,
    agentRoutes: plan.agentRoutes,
    routing: plan.routing,
    agents: plan.agents,
    ...(plan.site ? { site: plan.site } : {}),
  };
}
