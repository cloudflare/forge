import { bindings, defineConfig } from 'cf/config';

export default defineConfig({
  worker: {
    name: 'docs',
    compatibilityDate: '2026-07-21',
    compatibilityFlags: ['nodejs_compat'],
    // Serve Worker Previews at <preview-name>-docs.<subdomain>.workers.dev.
    // Takes effect once a production deploy applies it.
    previewUrls: true,
    env: {
      PRIVATE_ASSETS: bindings.r2({ name: 'api-docs-private' }),
    },
  },
});
