import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildRequest, InvalidArguments, listTools, param, toolsByName } from '../src/tool.js';
import { tools } from './fixtures.js';

const [list, create] = tools as [(typeof tools)[0], (typeof tools)[0]];

test('builds the path, query and headers', () => {
  const request = buildRequest(
    list,
    {
      path: { store_id: 'a b/c' },
      query: { tag: ['x', 'y'], sort: { by: 'name', dir: 'asc' } },
      headers: { 'x-trace': 7 },
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

test('refuses an argument the tool does not take, saying where a parameter goes', () => {
  assert.throws(() => buildRequest(list, { store_id: 's', tag: ['x'], verbose: true }, 'https://x'), {
    name: 'InvalidArguments',
    message:
      'Unknown arguments for pets_list: store_id goes in path: { "path": { "store_id": … } }; ' +
      'tag goes in query: { "query": { "tag": … } }; verbose is not an argument. It takes path, query, headers.',
  });
});

test('refuses a misspelled parameter inside a place, listing what it takes', () => {
  assert.throws(() => buildRequest(list, { path: { store_id: 's' }, query: { tagz: ['x'] } }, 'https://x'), {
    name: 'InvalidArguments',
    message:
      'Unknown arguments for pets_list: query.tagz is not an argument; query takes tag, sort. It takes path, query, headers.',
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

/** A tool whose body is in the media type its `content-type` argument names, as the generator writes one. */
const upload: (typeof tools)[0] = {
  name: 'files_put',
  description: 'Writes a file.',
  inputSchema: {
    type: 'object',
    properties: {
      headers: { type: 'object', properties: { 'content-type': { type: 'string' } } },
      body: {},
    },
    required: ['body'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  method: 'PUT',
  path: '/files',
  request: (args) => ({
    path: '/files',
    headers: [['content-type', param(args, 'headers', 'content-type')]],
    body: {
      value: args['body'],
      mediaTypes: ['application/octet-stream', 'multipart/form-data', 'text/csv', 'application/x-www-form-urlencoded'],
    },
  }),
};

test('sends a string body as it is, in the media type the content-type argument names', () => {
  assert.deepEqual(buildRequest(upload, { body: 'hello' }, 'https://x').body, 'hello');
  assert.equal(
    buildRequest(upload, { body: 'hello' }, 'https://x').headers['content-type'],
    'application/octet-stream',
  );
  const csv = buildRequest(upload, { headers: { 'content-type': 'text/csv' }, body: 'a,b' }, 'https://x');
  assert.equal(csv.headers['content-type'], 'text/csv');
  assert.equal(csv.body, 'a,b');
});

test('sends an object as multipart/form-data, as fetch sends FormData', async () => {
  const request = buildRequest(
    upload,
    {
      headers: { 'content-type': 'multipart/form-data' },
      body: { value: 'hi', metadata: { a: 1 }, tags: ['x', 'y'], skip: null },
    },
    'https://x',
  );
  assert.match(request.headers['content-type']!, /^multipart\/form-data; boundary=forge-/);
  const form = await new Response(request.body, { headers: request.headers }).formData();
  assert.equal(form.get('value'), 'hi');
  assert.equal(form.get('metadata'), '{"a":1}');
  assert.deepEqual(form.getAll('tags'), ['x', 'y']);
  assert.equal(form.has('skip'), false);
});

test('sends a file part with its name and media type, as FormData.append(name, blob, filename) does', async () => {
  const request = buildRequest(
    upload,
    {
      headers: { 'content-type': 'multipart/form-data' },
      body: {
        files: [{ content: 'export default {}', filename: 'index.js', contentType: 'application/javascript+module' }],
      },
    },
    'https://x',
  );
  const file = (await new Response(request.body, { headers: request.headers }).formData()).get('files');
  assert.ok(file instanceof Blob);
  assert.equal((file as File).name, 'index.js');
  assert.equal(file.type, 'application/javascript+module');
  assert.equal(await file.text(), 'export default {}');
});

test('takes a header argument in any case, and its content-type over the default', () => {
  const request = buildRequest(upload, { headers: { 'Content-Type': 'text/plain' }, body: 'hi' }, 'https://x');
  assert.equal(request.headers['content-type'], 'text/plain');
});

test('without a content-type, sends a string as text and an object as form data, as fetch picks one', async () => {
  const text = buildRequest(upload, { body: 'hello' }, 'https://x');
  assert.equal(text.headers['content-type'], 'application/octet-stream');
  const form = buildRequest(upload, { body: { value: 'hi' } }, 'https://x');
  assert.match(form.headers['content-type']!, /^multipart\/form-data; boundary=/);
  assert.equal((await new Response(form.body, { headers: form.headers }).formData()).get('value'), 'hi');
  const json = buildRequest(
    create,
    { path: { store_id: 's' }, query: { dry_run: true }, body: { name: 'Rex' } },
    'https://x',
  );
  assert.equal(json.headers['content-type'], 'application/json');
});

test('sends a file as the whole body as its contents, in its own media type', () => {
  const request = buildRequest(upload, { body: { content: 'a,b', contentType: 'text/csv' } }, 'https://x');
  assert.equal(request.headers['content-type'], 'text/csv');
  assert.equal(request.body, 'a,b');
});

test('sends a multipart body already encoded as it is, with the boundary from its first line', () => {
  const body = '--b1\r\nContent-Disposition: form-data; name="value"\r\n\r\nhi\r\n--b1--\r\n';
  const request = buildRequest(upload, { headers: { 'content-type': 'multipart/form-data' }, body }, 'https://x');
  assert.equal(request.headers['content-type'], 'multipart/form-data; boundary=b1');
  assert.equal(request.body, body);
});

test('sends an object as form pairs for application/x-www-form-urlencoded', () => {
  const request = buildRequest(
    upload,
    { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: { a: 'b c', n: 1, o: { x: 1 } } },
    'https://x',
  );
  assert.equal(request.body, 'a=b+c&n=1&o=%7B%22x%22%3A1%7D');
});
