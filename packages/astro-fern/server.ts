/** Renderer-facing API composed from neutral content and virtual runtime config. */
import { getEntry, getLiveEntry } from 'astro:content';
import { base, site } from 'astro:config/server';
import runtime from 'fern:virtual/runtime-config';
import { renderPageMarkdown } from './agents/index.ts';
import { FERN_CONTENT_COLLECTION, FERN_OPERATIONS_COLLECTION, FERN_PROJECT_ENTRY_ID } from './content-contract.ts';
import type { FernContentOperationEntrySchema, FernContentProjectEntrySchema } from './content/schema.ts';
import type { FernArtifactFetcher } from './operation-live-loader.ts';
import { buildSnapshotSwitch, type FernRouteContext } from './route-context.ts';
import {
  composeFernPage,
  type FernAgentLinksSchema,
  type FernAgentRoute,
  type FernDeploymentConfig,
  type FernPageSchema,
  type FernRoutePlan,
} from './route-plan.ts';
import {
  cacheFernOperation,
  cacheFernPage,
  createFernProjectRuntime,
  type FernProjectRuntime,
  type FernRequestCache,
  normalizeFernPath,
  renderFernLlmsResponse,
  resolveFernArtifactOrigin,
} from './server-runtime.ts';

export { createFernRequestCache } from './server-runtime.ts';
export type { FernRequestCache } from './server-runtime.ts';

const deployment: FernDeploymentConfig = { base, ...(site ? { site } : {}) };

async function readContentProject(): Promise<FernContentProjectEntrySchema> {
  const entry = await getEntry(FERN_CONTENT_COLLECTION, FERN_PROJECT_ENTRY_ID);
  if (!entry || entry.data.kind !== 'project') {
    throw new Error(
      `astro-fern: the "${FERN_CONTENT_COLLECTION}" collection has no project index; configure defineFernCollections() in content.config.ts`,
    );
  }
  return entry.data;
}

/** Controls how a server helper locates and deduplicates lazy operation artifacts. */
export interface FernOperationLoadOptions {
  /** Trusted origin used to construct artifact URLs and authorize global fetch. */
  origin?: string | URL;
  /** Supplies an origin to a custom transport when neither `origin` nor Astro `site` is set. */
  request?: Request;
  /** Optional Fetch-compatible transport; omitting it requires a trusted `origin` or Astro `site`. */
  fetcher?: FernArtifactFetcher;
  /** Request-lifetime cache created by {@link createFernRequestCache}. */
  cache?: FernRequestCache;
}

let cachedProject: FernProjectRuntime | undefined;

async function readProjectCache(): Promise<FernProjectRuntime> {
  const project = await readContentProject();
  if (cachedProject?.revision === project.revision) return cachedProject;
  cachedProject = createFernProjectRuntime(project, runtime, deployment);
  return cachedProject;
}

function readOperation(
  cache: FernProjectRuntime,
  entryId: string,
  snapshotId: string,
  options: FernOperationLoadOptions,
): Promise<FernContentOperationEntrySchema> {
  const artifactDigest = cache.operationArtifacts.get(snapshotId)?.get(entryId);
  if (!artifactDigest) {
    return Promise.reject(
      new Error(
        `astro-fern: no operation artifact exists for entry "${entryId}" in snapshot "${snapshotId}"; use page.entryId with its enclosing catalog snapshot's id, or use getFernPage(page.id)`,
      ),
    );
  }
  const load = async () => {
    const result = await getLiveEntry(FERN_OPERATIONS_COLLECTION, {
      id: entryId,
      digest: artifactDigest,
      origin: resolveFernArtifactOrigin(options, site),
      base,
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    });
    if ('error' in result) throw result.error;
    if (!result.entry) {
      throw new Error(
        `astro-fern: the live loader returned no entry for operation "${entryId}" in snapshot "${snapshotId}"; verify that the published digest is reachable through the configured origin or fetcher`,
      );
    }
    return result.entry.data;
  };
  return options.cache ? cacheFernOperation(options.cache, artifactDigest, entryId, load) : load();
}

function readPage(
  cache: FernProjectRuntime,
  pageId: string,
  options: FernOperationLoadOptions,
): Promise<FernPageSchema> {
  const reference = cache.pageReferences.get(pageId);
  if (!reference) {
    return Promise.reject(
      new Error(
        `astro-fern: page ID "${pageId}" is not in the active route plan; use a page.id returned by getFernCatalog() or getFernRoutePlan()`,
      ),
    );
  }
  const load = async () => {
    const operation = await readOperation(cache, reference.entryId, reference.snapshotId, options);
    return composeFernPage(cache.contentCatalog, operation, reference.snapshotId, runtime, deployment);
  };
  return options.cache ? cacheFernPage(options.cache, cache.revision, pageId, load) : load();
}

/**
 * Loads and validates one operation artifact from an exact documentation snapshot.
 *
 * @throws When the catalog is unavailable, no trusted artifact origin can be
 * resolved, the `(entryId, snapshotId)` pair is not in the catalog, or the
 * artifact is missing, malformed, stale, or cannot be fetched.
 * @param entryId Stable semantic operation ID from `FernCatalogPage.entryId`.
 * @param snapshotId ID of the `FernCatalogSnapshot` that encloses that page.
 * @param options Artifact transport and request-lifetime cache options.
 */
export async function getFernOperation(
  entryId: string,
  snapshotId: string,
  options: FernOperationLoadOptions = {},
): Promise<FernContentOperationEntrySchema> {
  return readOperation(await readProjectCache(), entryId, snapshotId, options);
}

/**
 * Composes one renderer-facing operation page from the compact catalog and its
 * exact lazy operation snapshot selected by the opaque page ID.
 *
 * @throws When `pageId` is unknown or operation loading fails.
 * @param pageId Opaque snapshot-specific page ID from the mounted Fern catalog.
 * @param options Artifact transport and request-lifetime cache options.
 */
export async function getFernPage(pageId: string, options: FernOperationLoadOptions = {}): Promise<FernPageSchema> {
  return readPage(await readProjectCache(), pageId, options);
}

/**
 * Resolves a mounted human pathname and lazily composes its operation page.
 * Returns `undefined` when the pathname is not a known human operation route.
 *
 * @throws When the route exists but its operation artifact cannot be loaded.
 */
export async function getFernPageForPath(
  pathname: string,
  options: FernOperationLoadOptions = {},
): Promise<{ page: FernPageSchema; target?: string } | undefined> {
  const project = await readProjectCache();
  const route = project.humanRoutes.get(normalizeFernPath(pathname));
  if (!route) return undefined;
  if (!project.pageReferences.has(route.pageId)) return undefined;
  const page = await readPage(project, route.pageId, options);
  return { page, ...(route.target ? { target: route.target } : {}) };
}

/** Returns the global snapshot registry and sparse product snapshot catalog from Astro's eager store. */
export async function getFernContentCatalog(): Promise<FernContentProjectEntrySchema['catalog']> {
  return (await readProjectCache()).contentCatalog;
}

/** Returns the mounted route plan without loading any operation artifacts. */
export async function getFernRoutePlan(): Promise<FernRoutePlan> {
  return (await readProjectCache()).routePlan;
}

/** Returns the mounted global snapshot registry and sparse product/snapshot/page catalog. */
export async function getFernCatalog(): Promise<FernRoutePlan['catalog']> {
  return (await readProjectCache()).routePlan.catalog;
}

/** Resolves snapshot-switcher context for a mounted pathname without loading an operation artifact. */
export async function getFernRouteContext(pathname: string): Promise<FernRouteContext> {
  return buildSnapshotSwitch((await readProjectCache()).routePlan, pathname);
}

/** Returns every generated Markdown and llms.txt route in stable plan order. */
export async function getAgentRoutes(): Promise<FernAgentRoute[]> {
  return (await readProjectCache()).routePlan.agentRoutes;
}

/**
 * Loads a page and returns its canonical Markdown and llms.txt relationships.
 *
 * @throws When `pageId` is unknown or operation loading fails.
 */
export async function getAgentLinks(
  pageId: string,
  options: FernOperationLoadOptions = {},
): Promise<FernAgentLinksSchema> {
  return (await getFernPage(pageId, options)).agentLinks;
}

/**
 * Builds Astro catch-all static-path records for all human operation routes.
 * This reads only the compact route plan; prerendered page bodies still require
 * an explicit build-time artifact transport.
 */
export async function getFernStaticPaths() {
  return (await readProjectCache()).routePlan.humanRoutes.map((route) => ({
    params: { slug: route.slug },
    props: { pageId: route.pageId, ...(route.target ? { target: route.target } : {}) },
  }));
}

/** Builds Astro static-path records for generated operation Markdown routes. */
export async function getMarkdownStaticPaths() {
  return (await readProjectCache()).routePlan.agentRoutes
    .filter((route) => route.kind === 'page-markdown')
    .map((route) => {
      if (!route.param) throw new Error(`astro-fern: Markdown route "${route.id}" is missing its route parameter`);
      return { params: { document: route.param }, props: { agentRouteId: route.id } };
    });
}

/** Builds Astro static-path records for non-site llms.txt routes. */
export async function getLlmsStaticPaths() {
  return (await readProjectCache()).routePlan.agentRoutes
    .filter((route) => route.kind === 'llms-index' && route.id !== 'llms:site')
    .map((route) => {
      if (!route.param) throw new Error(`astro-fern: llms.txt route "${route.id}" is missing its route parameter`);
      return { params: { scope: route.param }, props: { agentRouteId: route.id } };
    });
}

/**
 * Renders an operation Markdown response for a generated agent-route ID.
 * Unknown or non-Markdown IDs return a 404 response; artifact failures throw.
 */
export async function renderPageMarkdownResponse(
  routeId: string,
  options: FernOperationLoadOptions = {},
): Promise<Response> {
  const project = await readProjectCache();
  const route = project.agentRoutes.get(routeId);
  if (route?.kind !== 'page-markdown') return new Response('Not found', { status: 404 });
  if (!route?.pageId) return new Response('Not found', { status: 404 });
  if (!project.pageReferences.has(route.pageId)) return new Response('Not found', { status: 404 });
  const page = await readPage(project, route.pageId, options);
  const document = renderPageMarkdown(page, {
    ...(route.target ? { target: route.target } : {}),
    directive: project.routePlan.agents.directive,
  });
  return new Response(document.body, { headers: { 'Content-Type': document.contentType } });
}

/**
 * Resolves a Markdown pathname and renders its response.
 * Unknown paths return a 404 response; artifact failures throw.
 */
export async function renderPageMarkdownPathnameResponse(
  pathname: string,
  options: FernOperationLoadOptions = {},
): Promise<Response> {
  const route = (await readProjectCache()).agentRoutesByPath.get(normalizeFernPath(pathname));
  return route?.kind === 'page-markdown'
    ? renderPageMarkdownResponse(route.id, options)
    : new Response('Not found', { status: 404 });
}

/**
 * Renders an llms.txt response for a generated route ID using only the compact catalog.
 * Unknown or non-llms IDs return a 404 response.
 */
export async function renderLlmsResponse(routeId: string): Promise<Response> {
  return renderFernLlmsResponse(await readProjectCache(), routeId);
}

/** Resolves an llms.txt pathname and renders it, returning 404 for unknown paths. */
export async function renderLlmsPathnameResponse(pathname: string): Promise<Response> {
  const route = (await readProjectCache()).agentRoutesByPath.get(normalizeFernPath(pathname));
  return route?.kind === 'llms-index' ? renderLlmsResponse(route.id) : new Response('Not found', { status: 404 });
}
