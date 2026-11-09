import { markdownRoute } from '@cloudflare/nimbus-docs/agent-endpoints';
import type { APIRoute } from 'astro';

const markdown = markdownRoute();

/** Serves Nimbus's `/<page>/index.md` and 301s this site's old `/<page>.md` URLs to it. */
export const GET: APIRoute = async (context) => {
  const slug = context.params.slug ?? '';
  if (slug.split('/').at(-1) !== 'index') {
    return context.redirect(`${import.meta.env.BASE_URL}${slug}/index.md${context.url.search}`, 301);
  }
  return markdown.GET(context);
};
