import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildRequest, InvalidArguments, listTools, toolsByName } from '../src/index.js';
import { tools } from './fixtures.js';

const [list, create] = tools as [(typeof tools)[0], (typeof tools)[0]];

test('builds the path, query and headers', () => {
  const request = buildRequest(
    list,
    { store_id: 'a b/c', tag: ['x', 'y'], sort: { by: 'name', dir: 'asc' }, x_trace: 7 },
    'https://api.example.com/v1/',
  );
  assert.equal(request.method, 'GET');
  assert.equal(request.url, 'https://api.example.com/v1/stores/a%20b%2Fc/pets?tag=x&tag=y&sort=by%2Cname%2Cdir%2Casc');
  assert.equal(request.headers.get('X-Trace'), '7');
  assert.equal(request.headers.get('Accept'), 'application/json');
});

test('leaves out missing optional arguments', () => {
  const request = buildRequest(list, { store_id: 's', tag: null }, 'https://api.example.com');
  assert.equal(request.url, 'https://api.example.com/stores/s/pets');
  assert.equal(request.headers.has('X-Trace'), false);
});

test('sends the body as JSON', async () => {
  const request = buildRequest(create, { store_id: 's', body: { name: 'Rex' } }, 'https://api.example.com');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.get('Content-Type'), 'application/json');
  assert.deepEqual(await request.json(), { name: 'Rex' });
});

test('refuses missing required arguments and values that are not scalars', () => {
  assert.throws(() => buildRequest(create, { store_id: 's' }, 'https://x'), {
    name: 'InvalidArguments',
    message: 'Missing required arguments: body',
  });
  assert.throws(() => buildRequest(list, { store_id: '' }, 'https://x'), InvalidArguments);
  assert.throws(() => buildRequest(list, { store_id: 's', tag: [{}] }, 'https://x'), {
    message: 'tag must be a string, number or boolean',
  });
});

test('lists the tools without their request code, once', () => {
  const listing = listTools(tools);
  assert.equal(listing, listTools(tools));
  assert.deepEqual(Object.keys(listing[0]!).toSorted(), ['annotations', 'description', 'inputSchema', 'name', 'title']);
  assert.equal(toolsByName(tools).get('pets_create'), create);
});
