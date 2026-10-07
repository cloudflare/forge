// @ts-check
import cloudflare from '@astrojs/cloudflare';
import nimbus, { defineConfig as defineNimbusConfig } from '@cloudflare/nimbus-docs';
import { tableScroll } from '@cloudflare/nimbus-docs/markdown';
import tailwindcss from '@tailwindcss/vite';
import astroFern, { sanitizeFernMarkdownPlugin } from 'astro-fern';
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
        // Nimbus replaces Astro's Markdown processor, so astro-fern cannot install
        // its sanitizer on its own. OpenAPI descriptions are rendered with this
        // processor and are untrusted; astro-fern fails the build without it.
        mdastPlugins: [sanitizeFernMarkdownPlugin],
      },
    }),
    astroFern({
      collection: '_apiReference',
      routing: { base: '/', target: 'hash' },
      agents: { injectRoutes: false, markdown: false, llms: false },
    }),
  ],
});
