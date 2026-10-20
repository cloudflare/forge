import { defineConfig } from 'cf/config';

export default defineConfig({
  worker: {
    name: 'docs',
    compatibilityDate: '2026-07-21',
    compatibilityFlags: ['nodejs_compat'],
    domains: ['docs.experiments.devprod.cloudflare.dev'],
    // Serve Worker Previews at <preview-name>-docs.<subdomain>.workers.dev.
    // Takes effect once a production deploy applies it.
    previewUrls: true,
  },
});
