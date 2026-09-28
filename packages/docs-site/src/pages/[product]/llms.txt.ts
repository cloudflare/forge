import type { APIRoute } from 'astro';
import { renderLlmsIndexFromCatalog } from 'astro-fern/agents';
import { getApiRouter, getFernContentCatalog } from '../../api-server.ts';

export const GET: APIRoute = async ({ params, url }) => {
  if (!params.product) return new Response('Not found', { status: 404 });
  const router = await getApiRouter();
  const request = router.resolveLlms(params.product, url.searchParams);
  if (!request) return new Response('Not found', { status: 404 });
  const document = renderLlmsIndexFromCatalog(await getFernContentCatalog(), request, router.resolveHref);
  return new Response(document.body, { headers: { 'Content-Type': document.contentType } });
};
