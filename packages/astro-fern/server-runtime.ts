import { renderLlmsIndexFromCatalog, type SemanticHrefRequest, type SemanticLlmsHrefRequest } from './agents/index.ts';
import type {
  FernContentOperationEntrySchema,
  FernContentProjectEntrySchema,
  FernPageSchema,
} from './content/schema.ts';
import {
  composeFernRoutePlan,
  type FernAgentRoute,
  type FernCatalogPage,
  type FernDeploymentConfig,
  type FernRoutePlan,
} from './route-plan.ts';
import type { FernRuntimeConfig } from './runtime-config.ts';

export interface FernPageReference {
  /** Stable semantic operation ID referenced by this page's snapshot. */
  entryId: string;
  /** Digest for the operation bytes in this exact page snapshot. */
  artifactDigest: string;
  /** Canonical snapshot ID used to disambiguate the semantic operation ID. */
  snapshotId: string;
}

export interface FernProjectRuntime {
  revision: string;
  contentCatalog: FernContentProjectEntrySchema['catalog'];
  routePlan: FernRoutePlan;
  /** Artifact digests indexed first by canonical snapshot ID, then semantic operation entry ID. */
  operationArtifacts: Map<string, Map<string, string>>;
  /** Exact operation artifact reference for each opaque page ID. */
  pageReferences: Map<string, FernPageReference>;
  humanRoutes: Map<string, FernRoutePlan['humanRoutes'][number]>;
  agentRoutes: Map<string, FernAgentRoute>;
  agentRoutesByPath: Map<string, FernAgentRoute>;
  operationPages: Map<string, FernCatalogPage>;
  humanRoutesByPage: Map<string, FernRoutePlan['humanRoutes'][number]>;
  markdownRoutesByPage: Map<string, FernAgentRoute>;
  llmsRoutesByScope: Map<string, FernAgentRoute>;
}

/** Heavy values deduplicated only for the lifetime of one Astro request. */
export interface FernRequestCache {
  /** In-flight or completed operation loads keyed by immutable artifact digest. */
  operations: Map<string, Promise<FernContentOperationEntrySchema>>;
  /** In-flight or completed page compositions keyed by revision and page identity. */
  pages: Map<string, Promise<FernPageSchema>>;
}

/**
 * Creates an empty cache for one request lifecycle.
 *
 * Reusing this object within a request deduplicates operation fetches and page
 * composition. Do not share it between requests because operation payloads are
 * intentionally not retained as process-global state.
 */
export function createFernRequestCache(): FernRequestCache {
  return { operations: new Map(), pages: new Map() };
}

function cachePromise<TKey, TValue>(
  cache: Map<TKey, Promise<TValue>>,
  key: TKey,
  load: () => Promise<TValue>,
): Promise<TValue> {
  const existing = cache.get(key);
  if (existing) return existing;
  const promise = Promise.resolve().then(load);
  cache.set(key, promise);
  void promise.catch(() => {
    if (cache.get(key) === promise) cache.delete(key);
  });
  return promise;
}

export function cacheFernOperation(
  cache: FernRequestCache,
  artifactDigest: string,
  entryId: string,
  load: () => Promise<FernContentOperationEntrySchema>,
): Promise<FernContentOperationEntrySchema> {
  return cachePromise(cache.operations, key(artifactDigest, entryId), load);
}

export function cacheFernPage(
  cache: FernRequestCache,
  revision: string,
  pageId: string,
  load: () => Promise<FernPageSchema>,
): Promise<FernPageSchema> {
  return cachePromise(cache.pages, key(revision, pageId), load);
}

export function normalizeFernPath(pathname: string): string {
  const clean = pathname.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return clean === '' ? '/' : clean;
}

export function resolveFernArtifactOrigin(
  options: { origin?: string | URL; request?: Request; fetcher?: unknown },
  configuredSite?: string,
): string {
  const value = options.origin ?? configuredSite ?? (options.fetcher ? options.request?.url : undefined);
  if (!value) {
    throw new Error(
      'astro-fern: loading an operation with global fetch requires a trusted origin or Astro site config; request-derived origins require a custom fetcher',
    );
  }
  return new URL(value).origin;
}

function key(...values: Array<string | undefined>): string {
  return values.map((value) => (value === undefined ? '-' : `${value.length}:${value}`)).join('|');
}

function operationKey(productId: string, snapshotId: string, operationId: string, projectionId = 'primary'): string {
  return key(productId, snapshotId, operationId, projectionId);
}

function pageTargetKey(pageId: string, targetId?: string): string {
  return key(pageId, targetId);
}

function llmsKey(request: SemanticLlmsHrefRequest): string {
  if (request.scope === 'site') return key('site');
  if (request.scope === 'product') return key('product', request.productId);
  if (request.scope === 'snapshot') return key('snapshot', request.productId, request.snapshotId);
  return key('target', request.productId, request.snapshotId, request.targetId);
}

export function llmsRequestForRoute(route: FernAgentRoute): SemanticLlmsHrefRequest | undefined {
  const scope = route.scope ?? {};
  if (route.kind !== 'llms-index') return undefined;
  if (route.scopeKind === 'site') return { kind: 'llms', scope: 'site' };
  if (!scope.product) return undefined;
  if (route.scopeKind === 'product') return { kind: 'llms', scope: 'product', productId: scope.product };
  if (!scope.snapshot) return undefined;
  if (route.scopeKind === 'snapshot') {
    return { kind: 'llms', scope: 'snapshot', productId: scope.product, snapshotId: scope.snapshot };
  }
  if (route.scopeKind === 'target' && scope.target) {
    return {
      kind: 'llms',
      scope: 'target',
      productId: scope.product,
      snapshotId: scope.snapshot,
      targetId: scope.target,
    };
  }
  return undefined;
}

export function createFernProjectRuntime(
  project: FernContentProjectEntrySchema,
  runtime: FernRuntimeConfig,
  deployment: FernDeploymentConfig,
): FernProjectRuntime {
  const routePlan = composeFernRoutePlan(
    project.catalog,
    runtime,
    deployment,
    project.description ? { description: project.description } : {},
  );
  const operationArtifacts = new Map<string, Map<string, string>>();
  for (const product of project.catalog.products) {
    for (const snapshot of product.snapshots) {
      let snapshotArtifacts = operationArtifacts.get(snapshot.id);
      if (!snapshotArtifacts) {
        snapshotArtifacts = new Map();
        operationArtifacts.set(snapshot.id, snapshotArtifacts);
      }
      for (const section of snapshot.sections) {
        for (const operation of section.operations) {
          const existing = snapshotArtifacts.get(operation.entryId);
          if (existing && existing !== operation.artifactDigest) {
            throw new Error(
              `astro-fern: snapshot "${snapshot.id}" maps operation entry "${operation.entryId}" to multiple artifact digests; regenerate the catalog with one digest per snapshot and entry ID`,
            );
          }
          snapshotArtifacts.set(operation.entryId, operation.artifactDigest);
        }
      }
    }
  }
  const pageReferences = new Map<string, FernPageReference>();
  const operationPages = new Map<string, FernCatalogPage>();
  for (const product of routePlan.catalog.products) {
    for (const snapshot of product.snapshots) {
      for (const page of snapshot.pages) {
        const artifactDigest = operationArtifacts.get(snapshot.id)?.get(page.entryId);
        if (!artifactDigest) {
          throw new Error(
            `astro-fern: page "${page.id}" references operation entry "${page.entryId}" without an artifact in snapshot "${snapshot.id}"; regenerate the route plan and artifact catalog from the same project revision`,
          );
        }
        pageReferences.set(page.id, { entryId: page.entryId, artifactDigest, snapshotId: snapshot.id });
        operationPages.set(operationKey(product.id, snapshot.id, page.operationId, page.placement?.projectionId), page);
      }
    }
  }

  const humanRoutes = new Map(routePlan.humanRoutes.map((route) => [normalizeFernPath(route.pathname), route]));
  const humanRoutesByPage = new Map(
    routePlan.humanRoutes.map((route) => [pageTargetKey(route.pageId, route.target), route]),
  );
  const agentRoutes = new Map(routePlan.agentRoutes.map((route) => [route.id, route]));
  const agentRoutesByPath = new Map(routePlan.agentRoutes.map((route) => [normalizeFernPath(route.pathname), route]));
  const markdownRoutesByPage = new Map<string, FernAgentRoute>();
  const llmsRoutesByScope = new Map<string, FernAgentRoute>();
  for (const route of routePlan.agentRoutes) {
    if (route.kind === 'page-markdown' && route.pageId) {
      markdownRoutesByPage.set(pageTargetKey(route.pageId, route.target), route);
    }
    const request = llmsRequestForRoute(route);
    if (request) llmsRoutesByScope.set(llmsKey(request), route);
  }

  return {
    revision: project.revision,
    contentCatalog: project.catalog,
    routePlan,
    operationArtifacts,
    pageReferences,
    humanRoutes,
    agentRoutes,
    agentRoutesByPath,
    operationPages,
    humanRoutesByPage,
    markdownRoutesByPage,
    llmsRoutesByScope,
  };
}

function publicHref(plan: FernRoutePlan, pathname: string): string {
  return plan.site ? new URL(pathname, plan.site).href : pathname;
}

export function resolveFernSemanticHref(project: FernProjectRuntime, request: SemanticHrefRequest): string | undefined {
  if (request.kind === 'llms') {
    const route = project.llmsRoutesByScope.get(llmsKey(request));
    return route ? publicHref(project.routePlan, route.pathname) : undefined;
  }

  const page = project.operationPages.get(
    operationKey(request.productId, request.snapshotId, request.operationId, request.projectionId),
  );
  if (!page) return undefined;
  if (request.representation === 'human') {
    if (!request.targetId) return publicHref(project.routePlan, page.pathname);
    if (project.routePlan.routing.target === 'hash') {
      return publicHref(project.routePlan, `${page.pathname}#${encodeURIComponent(request.targetId)}`);
    }
    const route = project.humanRoutesByPage.get(pageTargetKey(page.id, request.targetId));
    return route ? publicHref(project.routePlan, route.pathname) : undefined;
  }
  const route = project.markdownRoutesByPage.get(pageTargetKey(page.id, request.targetId));
  return route ? publicHref(project.routePlan, route.pathname) : undefined;
}

export function renderFernLlmsResponse(project: FernProjectRuntime, routeId: string): Response {
  const route = project.agentRoutes.get(routeId);
  if (!route) return new Response('Not found', { status: 404 });
  const request = llmsRequestForRoute(route);
  if (!request) return new Response('Not found', { status: 404 });
  const document = renderLlmsIndexFromCatalog(project.contentCatalog, request, (href) =>
    resolveFernSemanticHref(project, href),
  );
  return new Response(document.body, { headers: { 'Content-Type': document.contentType } });
}
