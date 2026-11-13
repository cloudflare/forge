import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import nimbus, { defineConfig as defineNimbusConfig } from '@cloudflare/nimbus-docs';
import { tableScroll } from '@cloudflare/nimbus-docs/markdown';

const REPO = 'https://github.com/cloudflare/forge';

const nimbusConfig = defineNimbusConfig({
  // The canonical origin: canonical URLs, absolute OG image URLs, robots.txt,
  // the sitemap and the links in /llms.txt. Set `DOCS_SITE_URL` for any build
  // that is deployed; the fallback is only good for local work.
  site: process.env.DOCS_SITE_URL ?? 'http://localhost:4321',
  title: 'Forge',
  description:
    'A pluggable, schema-first code generator. Forge reads an OpenAPI document into one typed model and hands it to plugins that write SDKs, MCP tools, servers and docs.',
  locale: 'en',
  github: REPO,
  editPattern: `${REPO}/edit/main/packages/docs/{path}`,
  socialImageAlt: 'Forge documentation',
  // Groups follow the reading order of the project, not the directory tree.
  // `sidebar.order` in each page's frontmatter decides its place in a group.
  sidebar: {
    items: [
      { label: 'Start Here', autogenerate: { directory: 'start' } },
      { label: 'Core Concepts', autogenerate: { directory: 'concepts' } },
      { label: 'Writing Plugins', autogenerate: { directory: 'plugins' } },
      { label: 'Targets', autogenerate: { directory: 'targets' } },
      { label: 'Authoring OpenAPI', autogenerate: { directory: 'openapi' } },
      { label: 'Compatibility Modes', autogenerate: { directory: 'compatibility' } },
      { label: 'Guides', autogenerate: { directory: 'guides' } },
      {
        label: 'Reference',
        items: [{ autogenerate: { directory: 'reference' } }, { label: 'Releases', link: `${REPO}/releases` }],
      },
    ],
  },
});

export default defineConfig({
  output: 'static',
  vite: {
    plugins: [tailwindcss()],
  },
  // Pull the next page into the HTTP cache while the pointer rests on its
  // link. `public/_headers` gives pages a minute of freshness so the
  // prefetched copy is reused on the click.
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'hover',
  },
  integrations: [
    nimbus(nimbusConfig, {
      // Frontmatter has to validate for a page to render, and a broken
      // internal link is a 404 for a reader: both fail the build.
      rules: {
        'nimbus/frontmatter-shape': 'error',
        'nimbus/internal-link': 'error',
      },
      markdown: {
        // Wide tables scroll instead of overflowing the measure.
        hastPlugins: [tableScroll()],
        features: { headingAttributes: true },
      },
    }),
  ],
});
