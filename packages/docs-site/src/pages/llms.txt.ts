import type { APIRoute } from 'astro';
import { renderLlmsIndexFromCatalog } from 'astro-fern/agents';
import { getApiRouter, getFernContentCatalog } from '../api-server.ts';

export const GET: APIRoute = async () => {
  const router = await getApiRouter();
  const document = renderLlmsIndexFromCatalog(
    await getFernContentCatalog(),
    { kind: 'llms', scope: 'site' },
    router.resolveHref,
  );
  return new Response(document.body, { headers: { 'Content-Type': document.contentType } });
};
