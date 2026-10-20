import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createHandler, readBody } from '../src/index.js';
import { tools } from './fixtures.js';

/** Posts one JSON-RPC request to `handler` the way a 2026-07-28 client does, and returns its result. */
async function rpc(
  handler: ReturnType<typeof createHandler>,
  method: string,
  params: { name?: string; arguments?: object } = {},
) {
  const response = await handler.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': method,
        ...(params.name && { 'Mcp-Name': params.name }),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    }),
  );
  const text = await response.text();
  const json = text.startsWith('{')
    ? text
    : text
        .split('\n')
        .find((line) => line.startsWith('data:'))!
        .slice(5);
  return JSON.parse(json) as { result?: any; error?: any };
}

function handler(fetch: (request: Request) => Promise<Response>) {
  return createHandler({
    tools,
    baseUrl: 'https://api.example.com',
    serverInfo: { name: 'pets', version: '1.0.0' },
    authorize: (request) =>
      request.headers.get('X-Refuse') ? new Response('no', { status: 401 }) : { Authorization: 'Bearer t' },
    fetch,
  });
}

test('lists the tools', async () => {
  const { result } = await rpc(handler(fetch), 'tools/list');
  assert.deepEqual(
    result.tools.map((tool: { name: string }) => tool.name),
    ['pets_list', 'pets_create'],
  );
  assert.equal(result.tools[0].path, undefined);
});

test('calls a tool with the authorized headers', async () => {
  let sent: Request | undefined;
  const { result } = await rpc(
    handler(async (request) => {
      sent = request;
      return Response.json({ pets: ['Rex'] });
    }),
    'tools/call',
    { name: 'pets_list', arguments: { store_id: 's1' } },
  );
  assert.equal(sent?.url, 'https://api.example.com/stores/s1/pets');
  assert.equal(sent?.headers.get('Authorization'), 'Bearer t');
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), { pets: ['Rex'] });
});

test('returns API errors and bad arguments as tool errors', async () => {
  const api = handler(async () => Response.json({ error: 'nope' }, { status: 403, statusText: 'Forbidden' }));
  const refused = await rpc(api, 'tools/call', { name: 'pets_list', arguments: { store_id: 's1' } });
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /^403 Forbidden\n/);

  const missing = await rpc(api, 'tools/call', { name: 'pets_create', arguments: { store_id: 's1' } });
  assert.deepEqual(missing.result.content, [{ type: 'text', text: 'Missing required arguments: body' }]);
  assert.equal(missing.result.isError, true);

  const unknown = await rpc(api, 'tools/call', { name: 'nope', arguments: {} });
  assert.equal(unknown.result.content[0].text, 'Unknown tool: nope');
});

test('describes a body it cannot show', async () => {
  const body = await readBody(new Response(new Uint8Array(3), { headers: { 'Content-Type': 'image/png' } }));
  assert.equal(body, "The response is 3 bytes of image/png, which this tool can't show.");
  assert.equal(await readBody(new Response('a,b', { headers: { 'Content-Type': 'text/csv' } })), 'a,b');
});
