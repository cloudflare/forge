import { base } from 'astro:config/server';
import type { FernPageSchema } from 'astro-fern';
import type { FernArtifactFetcher } from 'astro-fern/live';
import {
  type FernOperationLoadOptions,
  getFernContentCatalog,
  getFernOperation,
  getFernPage,
  getFernRoutePlan,
} from 'astro-fern/server';
import {
  type ApiOperationSelection,
  type ApiPageSelection,
  type ApiProductSelection,
  type ApiResourceSelection,
  ApiRouter,
  type ApiSectionSelection,
} from './api-routing.ts';
import { requireAssetFetcher } from './artifact-fetcher.ts';
import { assertToolingRouteNamespace } from './command-reference/routing.ts';
import { withoutForgeAliases } from './forge-aliases.ts';
import { withTerraformTarget } from './terraform.ts';

export type ResolvedApiPage =
  | ApiProductSelection
  | ApiSectionSelection
  | ApiResourceSelection
  | (ApiOperationSelection & { page: FernPageSchema });

let routerPromise: Promise<ApiRouter> | undefined;

export function getApiRouter(): Promise<ApiRouter> {
  if (routerPromise) return routerPromise;
  const promise = getFernRoutePlan().then((source) => {
    const plan = { ...source, catalog: withoutForgeAliases(source.catalog) };
    assertToolingRouteNamespace(plan.catalog.products, plan.routing.base, base);
    return new ApiRouter(plan, base);
  });
  routerPromise = promise;
  void promise.catch(() => {
    if (routerPromise === promise) routerPromise = undefined;
  });
  return promise;
}

/**
 * The content catalog limited to the products the router serves, so agent
 * indexes omit products that exist only through Forge aliases. Alias
 * operations inside served products have no route and are skipped.
 */
export async function getApiContentCatalog(): Promise<Awaited<ReturnType<typeof getFernContentCatalog>>> {
  const [router, catalog] = await Promise.all([getApiRouter(), getFernContentCatalog()]);
  const served = new Set(router.plan.catalog.products.map((product) => product.id));
  return { ...catalog, products: catalog.products.filter((product) => served.has(product.id)) };
}

async function operationLoadOptions(request: Request, locals: App.Locals): Promise<FernOperationLoadOptions> {
  const { env } = await import('cloudflare:workers');
  const fetcher = requireAssetFetcher((env as unknown as { ASSETS?: FernArtifactFetcher }).ASSETS);
  return {
    request,
    fetcher,
    ...(locals.fernRequestCache ? { cache: locals.fernRequestCache } : {}),
  };
}

export async function getApiPage(url: URL, request: Request, locals: App.Locals): Promise<ResolvedApiPage | undefined> {
  const selection: ApiPageSelection | undefined = (await getApiRouter()).resolvePage(url);
  if (selection?.kind !== 'operation') return selection;
  const page = await getFernPage(selection.pageId, await operationLoadOptions(request, locals));
  return { ...selection, page: withTerraformTarget(page) };
}

export async function getApiOperation(
  url: URL,
  request: Request,
  locals: App.Locals,
  representation: 'human' | 'markdown' = 'human',
): Promise<(ApiOperationSelection & { page: FernPageSchema }) | undefined> {
  const router = await getApiRouter();
  const selection = router.resolveOperation(url, representation);
  if (!selection) return undefined;
  const page = await getFernPage(selection.pageId, await operationLoadOptions(request, locals));
  return { ...selection, page: withTerraformTarget(page) };
}

/** Loads one exact operation snapshot for deferred server-island rendering. */
export async function loadApiOperation(entryId: string, snapshotId: string, request: Request, locals: App.Locals) {
  return getFernOperation(entryId, snapshotId, await operationLoadOptions(request, locals));
}
