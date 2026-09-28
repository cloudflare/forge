/**
 * Ambient augmentation contributing `Astro.locals.fern` (the per-page
 * {@link FernRouteContext} set by astro-fern's middleware). Consuming apps opt
 * in by referencing this file from their `src/env.d.ts`:
 *
 *   /// <reference types="astro-fern/locals" />
 */
import type { FernRouteContext } from './route-context.ts';
import type { FernArtifactFetcher } from './operation-live-loader.ts';
import type { FernRequestCache } from './server.ts';

declare global {
  namespace App {
    interface Locals {
      /** Routing/snapshot context for the current page; populated by astro-fern middleware. */
      fern?: FernRouteContext;
      /** Adapter-local transport used by package-injected operation routes. */
      fernArtifactFetcher?: FernArtifactFetcher;
      /** Request-scoped cache used to deduplicate operation loads and page composition. */
      fernRequestCache?: FernRequestCache;
    }
  }
}

export {};
