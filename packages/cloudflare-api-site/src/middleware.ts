import { defineMiddleware } from 'astro:middleware';
import redirects from '../.forge/redirects.json';

const base = import.meta.env.BASE_URL.replace(/\/$/, '');
const moved: Record<string, string | undefined> = redirects;

/** Section ids, alias operation URLs and moved products 302 to the pages Nimbus draws. */
export const onRequest = defineMiddleware(({ url, redirect }, next) => {
  if (!url.pathname.startsWith(`${base}/`)) return next();
  const path = url.pathname.slice(base.length);
  const target = moved[path];
  if (target) return redirect(`${base}${target}${url.search}`, 302);
  return next();
});
