import type { APIRoute } from 'astro';
import { GET as pageMarkdown } from './[...slug]/index.md.ts';

/**
 * Astro matches `/<page>/index.md` here before `[...slug]/index.md.ts`, so this hands it on,
 * and 301s this site's old `/<page>.md` URLs, `/api.md` included, to it.
 */
export const GET: APIRoute = (context) => {
  const slug = context.params.slug ?? '';
  if (slug === 'index' || slug.endsWith('/index')) return pageMarkdown(context);
  const base = import.meta.env.BASE_URL;
  // The site's own root, `/api.md`, reaches this route with the base as its slug.
  const page = context.url.pathname === `${base.replace(/\/$/, '')}.md` ? '' : `${slug}/`;
  return context.redirect(`${base}${page}index.md${context.url.search}`, 301);
};
