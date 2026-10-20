// @ts-check
import cloudflare from '@astrojs/cloudflare';
import nimbus, { defineConfig as defineNimbusConfig } from '@cloudflare/nimbus-docs';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import astroFern from 'astro-fern';

const site = 'https://docs.experiments.devprod.cloudflare.dev';

const nimbusConfig = defineNimbusConfig({
  site,
  title: 'Cloudflare API',
  description: 'API reference generated from the Cloudflare OpenAPI spec by Forge.',
  locale: 'en',
  github: null,
  search: false,
  // Authored pages read the API catalog and the selected version at request
  // time, so the docs collection renders on demand like the API pages.
  rendering: { default: 'request' },
});

export default defineConfig({
  base: '/api',
  output: 'server',
  trailingSlash: 'always',
  adapter: cloudflare({ prerenderEnvironment: 'node' }),
  vite: {
    plugins: [tailwindcss()],
    // astro-fern builds operation artifact URLs from `site`, and in dev the
    // Cloudflare Vite plugin forwards ASSETS fetches to this server with that
    // host. Allow it so Vite's host check doesn't reject them with a 403.
    server: { allowedHosts: [new URL(site).hostname] },
  },
  integrations: [
    nimbus(nimbusConfig, {
      rules: {
        'nimbus/frontmatter-shape': 'error',
        'nimbus/internal-link': 'error',
      },
    }),
    astroFern({
      routing: { base: '/', target: 'hash' },
      agents: { injectRoutes: false, markdown: false, llms: false },
    }),
  ],
});
