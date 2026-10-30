import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildRequest, InvalidArguments, listTools, toolsByName } from '../src/tool.js';
import { tools } from './fixtures.js';

const [list, create] = tools as [(typeof tools)[0], (typeof tools)[0]];

test('builds the path, query and headers', () => {
  const request = buildRequest(
    list,
    {
      path: { store_id: 'a b/c' },
      query: { tag: ['x', 'y'], sort: { by: 'name', dir: 'asc' } },
      headers: { 'X-Trace': 7 },
    },
    'https://api.example.com/v1/',
  );
  assert.equal(request.method, 'GET');
  assert.equal(request.url, 'https://api.example.com/v1/stores/a%20b%2Fc/pets?tag=x&tag=y&sort=by%2Cname%2Cdir%2Casc');
  assert.deepEqual(request.headers, { accept: 'application/json', 'x-trace': '7' });
  assert.equal('body' in request, false);
});

test('joins a base URL that ends with slashes', () => {
  const request = buildRequest(list, { path: { store_id: 's' } }, 'https://api.example.com/v1///');
  assert.equal(request.url, 'https://api.example.com/v1/stores/s/pets');
});

test('leaves out missing optional arguments', () => {
  const request = buildRequest(list, { path: { store_id: 's' }, query: { tag: null } }, 'https://api.example.com');
  assert.equal(request.url, 'https://api.example.com/stores/s/pets');
  assert.equal('x-trace' in request.headers, false);
});

test('sends the body as JSON', () => {
  const request = buildRequest(
    create,
    { path: { store_id: 's' }, query: { dry_run: false }, body: { name: 'Rex' } },
    'https://api.example.com',
  );
  assert.equal(request.method, 'POST');
  assert.equal(request.url, 'https://api.example.com/stores/s/pets?dry_run=false');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.body, '{"name":"Rex"}');
});

test('is plain data that fetch sends as it is', async () => {
  const request = buildRequest(
    create,
    { path: { store_id: 's' }, query: { dry_run: true }, body: { name: 'Rex' } },
    'https://api.example.com',
  );
  assert.deepEqual(structuredClone(request), request);
  const sent = new Request(request.url, request);
  assert.equal(sent.method, 'POST');
  assert.equal(sent.headers.get('Content-Type'), 'application/json');
  assert.deepEqual(await sent.json(), { name: 'Rex' });
});

test('refuses missing required arguments and values that are not scalars', () => {
  assert.throws(() => buildRequest(create, { path: { store_id: 's' }, query: {} }, 'https://x'), {
    name: 'InvalidArguments',
    message: 'Missing required arguments: body, query.dry_run',
  });
  assert.throws(() => buildRequest(create, {}, 'https://x'), {
    message: 'Missing required arguments: path, query, body',
  });
  assert.throws(() => buildRequest(list, { path: { store_id: '' } }, 'https://x'), InvalidArguments);
  assert.throws(() => buildRequest(list, { path: { store_id: 's' }, query: { tag: [{}] } }, 'https://x'), {
    message: 'tag must be a string, number or boolean',
  });
});

test('refuses a place that is not an object', () => {
  assert.throws(() => buildRequest(list, { path: 's' }, 'https://x'), {
    name: 'InvalidArguments',
    message: 'path must be an object',
  });
  assert.throws(() => buildRequest(list, { path: { store_id: 's' }, query: ['tag'] }, 'https://x'), {
    message: 'query must be an object',
  });
});

test('lists the tools without their request code, once', () => {
  const listing = listTools(tools);
  assert.equal(listing, listTools(tools));
  assert.deepEqual(Object.keys(listing[0]!).toSorted(), ['annotations', 'description', 'inputSchema', 'name', 'title']);
  assert.equal(toolsByName(tools).get('pets_create'), create);
});

test('lists the output schemas only when asked, once', () => {
  const listing = listTools(tools, { outputSchema: true });
  assert.equal(listing, listTools(tools, { outputSchema: true }));
  assert.notEqual(listing, listTools(tools));
  assert.deepEqual(listing[0]!.outputSchema, list.outputSchema);
  assert.equal('outputSchema' in listing[1]!, false, 'a tool without one');
  assert.equal('outputSchema' in listTools(tools)[0]!, false);
});
