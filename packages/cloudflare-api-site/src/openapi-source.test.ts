import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fetchForgeOpenApi, forgeOpenApiUrl, loadForgeOpenApi } from './openapi-source.ts';

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

test('fetches and parses the Forge OpenAPI release asset', async () => {
  let requestedUrl: string | undefined;
  const fetcher = async (input: string | URL | Request) => {
    requestedUrl = String(input);
    return Response.json({ openapi: '3.0.3' }, { headers: { 'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT' } });
  };

  const { document, lastModified } = await fetchForgeOpenApi('openapi@test', fetcher);

  assert.equal(requestedUrl, 'https://github.com/cloudflare/forge/releases/download/openapi%40test/openapi.forge.json');
  assert.deepEqual(document, { openapi: '3.0.3' });
  assert.equal(lastModified?.toISOString(), '2026-10-21T07:28:00.000Z');
});

test('reports release asset download failures', async () => {
  const fetcher = async () => new Response(null, { status: 404, statusText: 'Not Found' });

  await assert.rejects(() => fetchForgeOpenApi('missing', fetcher), /404 Not Found.*openapi\.forge\.json/);
});

test('reports malformed release assets', async () => {
  const fetcher = async () => new Response('{', { headers: { 'content-type': 'application/json' } });

  await assert.rejects(() => fetchForgeOpenApi('malformed', fetcher), /Could not parse.*openapi\.forge\.json/);
});

test('ignores a Last-Modified header that is not a date', async () => {
  const fetcher = async () => Response.json({ openapi: '3.0.3' }, { headers: { 'last-modified': 'not a date' } });

  assert.equal((await fetchForgeOpenApi('openapi@test', fetcher)).lastModified, undefined);
});

test('loads an already-downloaded Forge OpenAPI artifact with its modification time', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-openapi-'));
  const path = join(dir, 'openapi.forge.json');
  await writeFile(path, '{"openapi":"3.0.3"}');

  const { document, lastModified } = await loadForgeOpenApi(path);

  assert.deepEqual(document, { openapi: '3.0.3' });
  assert.equal(lastModified?.getTime(), (await stat(path)).mtime.getTime());
  await rm(dir, { recursive: true });
});

test('reports an unreadable local Forge OpenAPI artifact', async () => {
  await assert.rejects(
    () => loadForgeOpenApi('missing/openapi.forge.json'),
    /Could not read the Forge OpenAPI artifact/,
  );
});
