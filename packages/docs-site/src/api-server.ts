import type { FernPageSchema } from 'astro-fern';
import type { FernArtifactFetcher } from 'astro-fern/live';
import { base } from 'astro:config/server';
import {
  getFernContentCatalog,
  getFernOperation,
  getFernPage,
  getFernRoutePlan,
  type FernOperationLoadOptions,
} from 'astro-fern/server';
import {
  ApiRouter,
  type ApiOperationSelection,
  type ApiPageSelection,
  type ApiProductSelection,
  type ApiResourceSelection,
  type ApiSectionSelection,
} from './api-routing.ts';
import { requireAssetFetcher } from './artifact-fetcher.ts';
import { assertToolingRouteNamespace } from './command-reference/routing.ts';
import { withTerraformTarget } from './terraform.ts';

export type ResolvedApiPage =
  | ApiProductSelection
  | ApiSectionSelection
  | ApiResourceSelection
  | (ApiOperationSelection & { page: FernPageSchema });

let routerPromise: Promise<ApiRouter> | undefined;

export function getApiRouter(): Promise<ApiRouter> {
  if (routerPromise) return routerPromise;
  const promise = getFernRoutePlan().then((plan) => {
    assertToolingRouteNamespace(plan.catalog.products, plan.routing.base, base);
    return new ApiRouter(plan, base);
  });
  routerPromise = promise;
  void promise.catch(() => {
    if (routerPromise === promise) routerPromise = undefined;
  });
  return promise;
}

export { getFernContentCatalog };

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
  if (!selection || selection.kind !== 'operation') return selection;
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
