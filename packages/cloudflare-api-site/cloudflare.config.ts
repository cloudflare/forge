import { defineConfig } from 'cf/config';

export default defineConfig(({ isPreview }) => ({
  worker: {
    name: 'docs',
    compatibilityDate: '2026-07-21',
    compatibilityFlags: ['nodejs_compat'],
    // Previews get their own preview URLs; only production owns the custom domain.
    domains: isPreview ? [] : ['docs.experiments.devprod.cloudflare.dev'],
  },
}));
