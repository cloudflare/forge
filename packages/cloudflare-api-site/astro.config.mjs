// @ts-check
import cloudflare from '@astrojs/cloudflare';
import nimbus, { defineConfig as defineNimbusConfig } from '@cloudflare/nimbus-docs';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import { builtForgeApi, forgeApi, isAstroPreview } from './src/forge-api.ts';

const site = 'https://docs.experiments.devprod.cloudflare.dev';

const internalSiteDomain = process.env['INTERNAL_SITE_DOMAIN']?.trim();
// `*.cloudflare.com` only one sub domain on purpose
const allowedDomains = [
  { protocol: 'https', hostname: '*.cloudflare.com' },
  { protocol: 'https', hostname: '**.cloudflare.dev' },
];
if (internalSiteDomain) {
  allowedDomains.push({ protocol: 'https', hostname: internalSiteDomain });
}

// `astro preview` serves the last build, so it takes that build's API entry
// instead of preparing the spec again.
const api = (isAstroPreview() && builtForgeApi()) || (await forgeApi());

const nimbusConfig = defineNimbusConfig({
  site,
  title: 'Cloudflare API',
  description: 'API reference generated from the Cloudflare OpenAPI spec by Forge.',
  locale: 'en',
  github: null,
  search: false,
  rendering: { default: 'request' },
  api: [api],
});

export default defineConfig({
  base: '/api',
  output: 'server',
  trailingSlash: 'always',
  adapter: cloudflare({ prerenderEnvironment: 'node' }),
  security: { allowedDomains },
  vite: {
    plugins: [tailwindcss()],
  },
  integrations: [
    nimbus(nimbusConfig, {
      icons: {
        include: {
          ph: [
            'caret-down',
            'caret-right',
            'check',
            'clock',
            'copy',
            'git-branch',
            'info',
            'lightbulb',
            'list',
            'markdown-logo',
            'moon',
            'pencil-simple',
            'sun',
            'warning',
            'warning-circle',
            'x',
          ],
          'simple-icons': ['go', 'python', 'terraform', 'typescript'],
        },
      },
      validateMdx: false,
      rules: {
        'nimbus/frontmatter-shape': 'error',
        'nimbus/internal-link': 'error',
      },
    }),
  ],
});
