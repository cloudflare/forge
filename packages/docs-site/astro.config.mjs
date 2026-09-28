// @ts-check
import cloudflare from '@astrojs/cloudflare';
import starlight from '@astrojs/starlight';
import astroFern from 'astro-fern';
import { defineConfig } from 'astro/config';

function optimizeServerDependencies() {
  return {
    name: 'optimize-server-dependencies',
    /** @param {string} environment */
    configEnvironment(environment) {
      if (environment !== 'client') {
        return {
          optimizeDeps: {
            include: ['@astrojs/starlight > postcss'],
          },
        };
      }
    },
  };
}

export default defineConfig({
  base: '/api',
  output: 'server',
  trailingSlash: 'always',
  adapter: cloudflare({ prerenderEnvironment: 'node' }),
  vite: {
    plugins: [optimizeServerDependencies()],
  },
  integrations: [
    astroFern({
      routing: { base: '/', target: 'hash' },
      agents: { injectRoutes: false, markdown: false, llms: false },
    }),
    starlight({
      title: 'Cloudflare API',
      description: 'API reference generated from the Cloudflare OpenAPI spec by Forge.',
      favicon: '/favicon.svg',
      prerender: false,
      pagefind: false,
      pagination: false,
      customCss: ['@fontsource-variable/inter', '@fontsource-variable/jetbrains-mono', './src/styles/cloudflare.css'],
      components: {
        PageTitle: './src/components/PageTitle.astro',
        Sidebar: './src/components/Sidebar.astro',
        SiteTitle: './src/components/SiteTitle.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
      },
      sidebar: [{ label: 'Overview', link: '/' }],
      routeMiddleware: './src/starlight-route-data.ts',
    }),
  ],
});
