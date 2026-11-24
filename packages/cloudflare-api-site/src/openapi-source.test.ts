import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forgeOpenApiSource, forgeOpenApiUrl } from './openapi-source.ts';

test('uses the latest Forge OpenAPI release by default', () => {
  assert.equal(
    forgeOpenApiUrl(undefined).href,
    'https://github.com/cloudflare/forge/releases/latest/download/openapi.forge.json',
  );
});

test('uses an exact encoded Forge OpenAPI release when pinned', () => {
  assert.equal(
    forgeOpenApiUrl('openapi@8c827d1b18fec9aa686debf894580f0b302f6f94').href,
    'https://github.com/cloudflare/forge/releases/download/openapi%408c827d1b18fec9aa686debf894580f0b302f6f94/openapi.forge.json',
  );
});

test('reads the release asset as a URL source, or a local spec file instead', () => {
  assert.deepEqual(forgeOpenApiSource(undefined, 'openapi@abc'), {
    sources: {
      forge: { url: 'https://github.com/cloudflare/forge/releases/download/openapi%40abc/openapi.forge.json' },
    },
    spec: { source: 'forge' },
  });
  assert.deepEqual(forgeOpenApiSource('cached/openapi.forge.json', 'openapi@abc'), {
    spec: 'cached/openapi.forge.json',
  });
});
