import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CatalogueTool } from '../src/catalogue.ts';
import { buildRequest, InvalidArguments } from '../src/request.ts';

const BASE = 'https://api.example.com/v1/';

function tool(request: CatalogueTool['request'], required: string[] = []): CatalogueTool {
  return {
    name: 't',
    description: '',
    inputSchema: { type: 'object', properties: {}, required },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    request,
  };
}

test('path parameters are encoded, and query and header parameters are set', () => {
  const request = buildRequest(
    tool({
      method: 'GET',
      path: '/zones/{zone_id}/records/{name}',
      params: [
        { key: 'zone_id', name: 'zone_id', in: 'path' },
        { key: 'name', name: 'name', in: 'path' },
        { key: 'page', name: 'page', in: 'query', explode: true },
        { key: 'unset', name: 'unset', in: 'query', explode: true },
        { key: 'if_match', name: 'If-Match', in: 'header' },
      ],
    }),
    { zone_id: 'abc', name: 'a b/c', page: 2, if_match: 'etag' },
    BASE,
  );

  assert.equal(request.method, 'GET');
  assert.equal(request.url, 'https://api.example.com/v1/zones/abc/records/a%20b%2Fc?page=2');
  assert.equal(request.headers.get('If-Match'), 'etag');
  assert.equal(request.headers.get('Accept'), 'application/json');
});

test('query arrays and objects follow the form style, exploded or not', () => {
  const request = buildRequest(
    tool({
      method: 'GET',
      path: '/things',
      params: [
        { key: 'ids', name: 'id', in: 'query', explode: true },
        { key: 'tags', name: 'tags', in: 'query', explode: false },
        { key: 'filter', name: 'filter', in: 'query', explode: true },
      ],
    }),
    { ids: [1, 2], tags: ['a', 'b'], filter: { status: 'active', type: 'A' } },
    BASE,
  );

  assert.equal(new URL(request.url).search, '?id=1&id=2&tags=a%2Cb&status=active&type=A');
});

test('the JSON body is sent as given, with its media type', async () => {
  const request = buildRequest(
    tool({ method: 'POST', path: '/things', params: [], body: { key: 'body', mediaType: 'application/json' } }),
    { body: { name: 'x', nested: { port: 5432 } } },
    BASE,
  );

  assert.equal(request.headers.get('Content-Type'), 'application/json');
  assert.deepEqual(await request.json(), { name: 'x', nested: { port: 5432 } });
});

test('missing required arguments and unfilled path parameters are refused', () => {
  const route = {
    method: 'GET',
    path: '/zones/{zone_id}',
    params: [{ key: 'zone_id', name: 'zone_id', in: 'path' as const }],
  };

  assert.throws(
    () => buildRequest(tool(route, ['zone_id']), {}, BASE),
    new InvalidArguments('Missing required arguments: zone_id'),
  );
  assert.throws(() => buildRequest(tool(route), {}, BASE), new InvalidArguments('Missing path parameter: zone_id'));
  assert.throws(() => buildRequest(tool(route), { zone_id: { a: 1 } }, BASE), InvalidArguments);
});
