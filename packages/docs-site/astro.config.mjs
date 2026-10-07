// @ts-check
import cloudflare from '@astrojs/cloudflare';
import nimbus, { defineConfig as defineNimbusConfig } from '@cloudflare/nimbus-docs';
import { tableScroll } from '@cloudflare/nimbus-docs/markdown';
import tailwindcss from '@tailwindcss/vite';
import astroFern from 'astro-fern';
import { defineConfig } from 'astro/config';

const nimbusConfig = defineNimbusConfig({
  site: 'https://docs.experiments.devprod.cloudflare.dev',
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
  },
  integrations: [
    nimbus(nimbusConfig, {
      rules: {
        'nimbus/frontmatter-shape': 'error',
        'nimbus/internal-link': 'error',
      },
      markdown: {
        hastPlugins: [tableScroll()],
      },
    }),
    // After Nimbus: Nimbus replaces Astro's Markdown processor, and astro-fern
    // installs its sanitizer into whichever processor is active when it runs.
    astroFern({
      collection: '_apiReference',
      routing: { base: '/', target: 'hash' },
      agents: { injectRoutes: false, markdown: false, llms: false },
    }),
  ],
});
