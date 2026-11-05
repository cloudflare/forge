import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchForgeOpenApi, forgeOpenApiUrl, loadForgeOpenApi } from './openapi-source.ts';

test('uses the latest cloudflare/api-schemas main spec by default', () => {
  assert.equal(
    forgeOpenApiUrl(undefined).href,
    'https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json',
  );
});

test('uses an exact cloudflare/api-schemas revision when pinned', () => {
  assert.equal(
    forgeOpenApiUrl('openapi@8c827d1b18fec9aa686debf894580f0b302f6f94').href,
    'https://raw.githubusercontent.com/cloudflare/api-schemas/8c827d1b18fec9aa686debf894580f0b302f6f94/openapi.json',
  );
});

test('fetches and parses the Forge OpenAPI asset', async () => {
  let requestedUrl: string | undefined;
  const fetcher = async (input: string | URL | Request) => {
    requestedUrl = String(input);
    return Response.json({ openapi: '3.0.3' });
  };

  const document = await fetchForgeOpenApi('openapi@test', fetcher);

  assert.equal(requestedUrl, 'https://raw.githubusercontent.com/cloudflare/api-schemas/test/openapi.json');
  assert.deepEqual(document, { openapi: '3.0.3' });
});

test('reports release asset download failures', async () => {
  const fetcher = async () => new Response(null, { status: 404, statusText: 'Not Found' });

  await assert.rejects(() => fetchForgeOpenApi('missing', fetcher), /404 Not Found.*openapi\.json/);
});

test('reports malformed release assets', async () => {
  const fetcher = async () => new Response('{', { headers: { 'content-type': 'application/json' } });

  await assert.rejects(() => fetchForgeOpenApi('malformed', fetcher), /Could not parse.*openapi\.json/);
});

test('loads an already-downloaded Forge OpenAPI artifact', async () => {
  let requestedPath: string | undefined;
  const document = await loadForgeOpenApi('cached/openapi.forge.json', undefined, async (path) => {
    requestedPath = path;
    return '{"openapi":"3.0.3"}';
  });

  assert.equal(requestedPath, 'cached/openapi.forge.json');
  assert.deepEqual(document, { openapi: '3.0.3' });
});
