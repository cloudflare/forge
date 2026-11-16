import { defineConfig } from 'cf/config';

// A static site: no `entrypoint`, so there is no Worker script and every request
// is served from the asset store. `cf` runs `astro build` and uploads `dist/`.
//
// There is no `accountId` and no `domains` yet. Add both once the site has a
// home: pinning the account stops a deploy from an operator who can see several
// accounts from landing in the wrong one, and a custom domain should come with
// `workersDev: false` so the site has one origin. Build with `DOCS_SITE_URL` set
// to that origin, since canonicals, OG URLs and the sitemap are built from it.
export default defineConfig({
  worker: {
    name: 'forge-docs',
    compatibilityDate: '2026-10-01',
    assets: {
      // Astro emits `about/index.html` for `/about/`, and the docs link to those
      // directory paths throughout. This resolves them and redirects the
      // non-slashed form instead of 404ing.
      htmlHandling: 'auto-trailing-slash',
      // A missing page renders the site's own 404, not the bare asset-store one.
      notFoundHandling: '404-page',
    },
  },
});
