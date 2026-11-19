import { getApiModel, getApiPageProps, getApiPageSlugs } from '@cloudflare/nimbus-docs/api';
import type { APIRoute } from 'astro';
import { buildSearchManifest } from '../search-manifest.ts';

// Built once with the site, so the search index loads a static file.
export const prerender = true;

export const GET: APIRoute = async () => {
  const model = await getApiModel('api');
  const pages = getApiPageSlugs(model).map(({ coordinate }) => getApiPageProps(model, coordinate));
  return new Response(JSON.stringify(buildSearchManifest(pages, import.meta.env.BASE_URL)), {
    headers: { 'Content-Type': 'application/json' },
  });
};
