import { defineConfig } from 'cf/config';

// A static site: no `entrypoint`, so there is no Worker script and every request
// is served from the asset store. `cf build` runs `astro build`, whose Cloudflare
// adapter writes the Build Output that `cf deploy` uploads.
//
// CI deploys it to the account in the repository's `CLOUDFLARE_ACCOUNT_ID`
// secret, at its workers.dev address, until it has a domain. Then add `domains`
// with `workersDev: false`, so the site has one origin, and build with
// `DOCS_SITE_URL` set to it: canonicals, OG URLs and the sitemap are built from it.
export default defineConfig({
  worker: {
    name: 'forge-docs',
    compatibilityDate: '2026-10-01',
    // Serve Worker Previews at <preview-name>-forge-docs.<subdomain>.workers.dev.
    // Takes effect once a production deploy applies it.
    previewUrls: true,
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
