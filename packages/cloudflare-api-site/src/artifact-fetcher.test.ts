import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireAssetFetcher } from './artifact-fetcher.ts';

test('operation loading requires the Cloudflare ASSETS binding', () => {
  assert.throws(() => requireAssetFetcher(undefined), /ASSETS binding is required/);
  assert.throws(() => requireAssetFetcher({} as never), /ASSETS binding is required/);

  const assets = { fetch: async () => new Response() };
  assert.equal(requireAssetFetcher(assets), assets);
});
