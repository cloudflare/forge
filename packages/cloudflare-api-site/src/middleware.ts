import { defineMiddleware } from 'astro:middleware';
import redirects from '../.forge/redirects.json';
import stainlessLookup from '../.forge/stainless-lookup.json';
import { stainlessRedirect } from './stainless-redirects.ts';

const base = import.meta.env.BASE_URL.replace(/\/$/, '');
const moved: Record<string, string | undefined> = redirects;
const stainless: Record<string, string | undefined> = stainlessLookup;

/**
 * Section ids, alias operation URLs and moved products 302 to the pages Nimbus
 * draws. The retired Stainless site's pages, their Markdown twins and their
 * language variants 301 to theirs.
 */
export const onRequest = defineMiddleware(({ url, redirect }, next) => {
  if (!url.pathname.startsWith(`${base}/`)) return next();
  const path = url.pathname.slice(base.length);
  const target = moved[path];
  if (target) return redirect(`${base}${target}${url.search}`, 302);
  const stainlessTarget = stainlessRedirect(path, url.search, stainless);
  if (stainlessTarget) return redirect(`${base}${stainlessTarget}`, 301);
  return next();
});
