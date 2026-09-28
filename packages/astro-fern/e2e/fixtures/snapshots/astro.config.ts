import astroFern from 'astro-fern';
import { defineConfig } from 'astro/config';
import { E2E_FIXTURES } from '../../fixtures.ts';

const fixture = E2E_FIXTURES.snapshots;

export default defineConfig({
  base: fixture.base,
  output: 'server',
  trailingSlash: 'always',
  integrations: [astroFern({ routing: { base: '/api', target: 'path' } })],
});
