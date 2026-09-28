/**
 * Astro middleware that resolves the {@link FernRouteContext} for the pathname
 * being rendered and exposes it as `Astro.locals.fern`. Registered by the
 * integration (`astro:config:setup` → `addMiddleware`), it runs for every route
 * — route middleware and on-demand handlers — and
 * yields an empty context for paths that are not fern operation pages.
 */
import { defineMiddleware } from 'astro:middleware';
import type { FernArtifactFetcher } from './operation-live-loader.ts';
import { createFernRequestCache, getFernRouteContext } from './server.ts';

const developmentArtifactFetcher: FernArtifactFetcher | undefined = import.meta.env.DEV
  ? { fetch: (request) => fetch(request) }
  : undefined;

export const onRequest = defineMiddleware(async (context, next) => {
  context.locals.fernRequestCache ??= createFernRequestCache();
  context.locals.fernArtifactFetcher ??= developmentArtifactFetcher;
  context.locals.fern = await getFernRouteContext(context.url.pathname);
  return next();
});
