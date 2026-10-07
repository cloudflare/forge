import type { APIRoute } from 'astro';
import { getLlmsPayload } from '@cloudflare/nimbus-docs/agent-endpoints';
import { renderLlmsIndexFromCatalog } from 'astro-fern/agents';
import { getApiRouter, getFernContentCatalog } from '../api-server.ts';

// Rendered on request: the authored pages come from the index Nimbus prepares
// at build time, followed by the API products astro-fern resolves per request.
export const prerender = false;

/** Drops a Markdown document's leading H1 so its sections can follow another document. */
function withoutTitle(body: string): string {
  return body.replace(/^# [^\n]*\n+/, '');
}

export const GET: APIRoute = async ({ request }) => {
  const [docs, router, catalog] = await Promise.all([
    getLlmsPayload({ scope: 'site', surface: 'index' }, { request }),
    getApiRouter(),
    getFernContentCatalog(),
  ]);
  const api = renderLlmsIndexFromCatalog(catalog, { kind: 'llms', scope: 'site' }, router.resolveHref);
  const body = docs ? `${docs.body.trimEnd()}\n\n${withoutTitle(api.body)}` : api.body;
  return new Response(body, { headers: { 'Content-Type': api.contentType } });
};
