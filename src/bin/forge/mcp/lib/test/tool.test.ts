import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CallToolResult, McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';

import { buildRequest, encodePath, OPERATION, operation, registerTools } from '../src/tool.js';
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

test('fills in a path template written as a tagged template', () => {
  const pathOf = encodePath`/a/${'x'}/b/${'y'}`;
  assert.equal(pathOf({ x: 'a b/c', y: 7 }), '/a/a%20b%2Fc/b/7');
  assert.equal(encodePath`/zones`({}), '/zones');
  assert.throws(() => pathOf({ x: 'x' }), { message: 'Missing path parameter: y' });
});

test('refuses an empty path parameter and values a query parameter cannot be', () => {
  assert.throws(() => buildRequest(list, { path: { store_id: '' } }, 'https://x'), {
    message: 'Missing path parameter: store_id',
  });
  assert.throws(() => buildRequest(list, { path: { store_id: 's' }, query: { tag: [{}] } }, 'https://x'), {
    message: 'tag must be a string, number or boolean',
  });
});

test('sends a tool as MCP Tool, without the operation it calls', () => {
  const sent = JSON.parse(JSON.stringify(list)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(sent).toSorted(), [
    'annotations',
    'description',
    'inputSchema',
    'name',
    'outputSchema',
    'title',
  ]);
  assert.deepEqual(sent['outputSchema'], list.outputSchema);
  assert.equal('outputSchema' in JSON.parse(JSON.stringify(create)), false, 'a tool without one');
  assert.equal(operation(list).path, '/stores/{store_id}/pets');
  assert.equal(operation({ ...list, description: 'Changed.' }), operation(list), 'a changed copy keeps it');
});

/** What `registerTools` passes to `registerTool` for a tool. */
interface Registered {
  readonly config: {
    readonly title?: string;
    readonly description?: string;
    readonly inputSchema: StandardSchemaWithJSON;
    readonly outputSchema?: StandardSchemaWithJSON;
    readonly annotations?: object;
  };
  readonly callback: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

/** Registers the tools with `options` on a server that records them, and returns them by name. */
function register(options: Parameters<typeof registerTools>[2]): ReadonlyMap<string, Registered> {
  const registered = new Map<string, Registered>();
  const server = {
    registerTool: (name: string, config: Registered['config'], callback: Registered['callback']) => {
      registered.set(name, { config, callback });
    },
  };
  registerTools(server as unknown as McpServer, tools, options);
  return registered;
}

/** The JSON Schema a registered schema is listed as. */
function listed(schema: StandardSchemaWithJSON | undefined): unknown {
  return schema?.['~standard'].jsonSchema.input({ target: 'draft-2020-12' });
}

test('registers each tool as tools/list sends it, for the SDK to validate its arguments', async () => {
  const registered = register({ baseUrl: 'https://x' });
  assert.deepEqual([...registered.keys()], ['pets_list', 'pets_create']);
  const { config } = registered.get('pets_list')!;
  assert.equal(config.title, list.title);
  assert.equal(config.description, list.description);
  assert.deepEqual(config.annotations, list.annotations);
  assert.deepEqual(listed(config.inputSchema), list.inputSchema);
  assert.deepEqual(listed(config.outputSchema), list.outputSchema);
  assert.equal(registered.get('pets_create')!.config.outputSchema, undefined, 'a tool without one');

  const valid = { path: { store_id: 's' }, query: { tag: ['x'] }, headers: { 'x-trace': 't' } };
  assert.deepEqual(await config.inputSchema['~standard'].validate(valid), { value: valid });
  for (const args of [
    { store_id: 's' },
    { path: { store_id: 's' }, query: { tagz: ['x'] } },
    { path: {} },
    { path: 's' },
    { path: { store_id: 1 } },
    { path: { store_id: 's' }, headers: { 'X-Trace': 't' } },
  ]) {
    const result = await config.inputSchema['~standard'].validate(args);
    assert.ok(result.issues?.length, `refuses ${JSON.stringify(args)}`);
  }
  assert.deepEqual(
    await config.outputSchema!['~standard'].validate('any'),
    { value: 'any' },
    'results are the client’s to check',
  );
});

test('calls the API for a tool and returns the body', async () => {
  const sent: Request[] = [];
  const { callback } = register({
    baseUrl: 'https://x/',
    fetch: async (input) => {
      sent.push(new Request(input));
      return Response.json([{ id: 'p1' }]);
    },
  }).get('pets_list')!;
  const result = await callback({ path: { store_id: 's' }, query: { tag: ['a', 'b'] } });
  assert.equal(sent[0]!.method, 'GET');
  assert.equal(sent[0]!.url, 'https://x/stores/s/pets?tag=a&tag=b');
  assert.deepEqual(result, {
    content: [{ type: 'text', text: '[{"id":"p1"}]' }],
    structuredContent: [{ id: 'p1' }],
  });
});

test('returns a refusal as an error result, and throws for a request it cannot build', async () => {
  const { callback } = register({
    baseUrl: 'https://x',
    fetch: async () => Response.json({ errors: ['forbidden'] }, { status: 403 }),
  }).get('pets_list')!;
  assert.deepEqual(await callback({ path: { store_id: 's' } }), {
    content: [{ type: 'text', text: 'HTTP 403: {"errors":["forbidden"]}' }],
    isError: true,
  });
  // McpServer returns what a callback throws as an error result.
  await assert.rejects(callback({ path: { store_id: '' } }), { message: 'Missing path parameter: store_id' });
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
  [OPERATION]: {
    method: 'PUT',
    path: '/files',
    pathOf: encodePath`/files`,
    headers: ['content-type'],
    body: {
      mediaTypes: ['application/octet-stream', 'multipart/form-data', 'text/csv', 'application/x-www-form-urlencoded'],
    },
  },
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

test('sends the content-type a header argument names over the default', () => {
  const request = buildRequest(upload, { headers: { 'content-type': 'text/plain' }, body: 'hi' }, 'https://x');
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
