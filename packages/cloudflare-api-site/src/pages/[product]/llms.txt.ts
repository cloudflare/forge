import type { APIRoute } from 'astro';
import { getLlmsPayload } from '@cloudflare/nimbus-docs/agent-endpoints';
import { renderLlmsIndexFromCatalog } from 'astro-fern/agents';
import { getApiRouter, getFernContentCatalog } from '../../api-server.ts';

// `/<segment>/llms.txt` is shared: API products resolve through astro-fern, and
// any other segment falls back to the Nimbus index of that authored section.
export const prerender = false;

export const GET: APIRoute = async ({ params, request, url }) => {
  const product = params.product;
  if (!product) return new Response('Not found', { status: 404 });
  const router = await getApiRouter();
  const selection = router.resolveLlms(product, url.searchParams);
  if (selection) {
    const document = renderLlmsIndexFromCatalog(await getFernContentCatalog(), selection, router.resolveHref);
    return new Response(document.body, { headers: { 'Content-Type': document.contentType } });
  }
  const section = await getLlmsPayload({ scope: 'section', surface: 'index', section: product }, { request });
  if (!section) return new Response('Not found', { status: 404 });
  return new Response(section.body, { headers: { 'Content-Type': section.mediaType } });
};
