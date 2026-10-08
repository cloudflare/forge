import type { APIRoute } from 'astro';
import { renderPageMarkdown } from 'astro-fern/agents';
import { getApiOperation, getApiRouter } from '../api-server.ts';

export const GET: APIRoute = async ({ locals, request, url }) => {
  const resolved = await getApiOperation(url, request, locals, 'markdown');
  if (!resolved) return new Response('Not found', { status: 404 });
  const router = await getApiRouter();
  const document = renderPageMarkdown(resolved.page, {
    ...(resolved.lang ? { target: resolved.lang } : {}),
    directive: router.plan.agents.directive,
    resolveHref: router.resolveHref,
  });
  return new Response(document.body, { headers: { 'Content-Type': document.contentType } });
};
