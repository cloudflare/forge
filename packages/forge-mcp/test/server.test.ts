import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Catalogue } from '../src/catalogue.ts';
import { createForgeMcpHandler } from '../src/server.ts';

const catalogue: Catalogue = {
  format: 'forge-mcp/1',
  api: { version: '1', baseUrl: 'https://api.example.com/v1' },
  skipped: [],
  tools: [
    {
      name: 'zones_get',
      title: 'Get a zone',
      description: 'Get a zone.',
      inputSchema: { type: 'object', properties: { zone_id: { type: 'string' } }, required: ['zone_id'] },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      request: { method: 'GET', path: '/zones/{zone_id}', params: [{ key: 'zone_id', name: 'zone_id', in: 'path' }] },
    },
  ],
};

/** A 2026-07-28 request, with the per-request envelope the protocol requires. */
function mcp(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}): Request {
  return new Request('https://mcp.example.com/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': method,
      ...(typeof params.name === 'string' && { 'Mcp-Name': params.name }),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
}

async function result(response: Response): Promise<any> {
  const text = await response.text();
  const json = response.headers.get('Content-Type')?.includes('text/event-stream')
    ? text
        .split('\n')
        .find((line) => line.startsWith('data:'))!
        .slice(5)
    : text;
  return JSON.parse(json);
}

function handler(calls: Request[] = [], status = 200) {
  return createForgeMcpHandler({
    catalogue,
    authorize: (request) => {
      const authorization = request.headers.get('Authorization');
      return authorization ? { Authorization: authorization } : new Response('Unauthorized', { status: 401 });
    },
    fetch: async (request) => {
      calls.push(request);
      return Response.json({ success: status === 200, result: { id: 'abc' } }, { status });
    },
  });
}

test('tools/list returns the catalogue tools without their routes', async () => {
  const body = await result(await handler().fetch(mcp('tools/list', {}, { Authorization: 'Bearer t' })));

  assert.deepEqual(body.result.tools, [
    {
      name: 'zones_get',
      title: 'Get a zone',
      description: 'Get a zone.',
      inputSchema: { type: 'object', properties: { zone_id: { type: 'string' } }, required: ['zone_id'] },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
  ]);
});

test('tools/call makes the API request with the authorized headers', async () => {
  const calls: Request[] = [];
  const body = await result(
    await handler(calls).fetch(
      mcp('tools/call', { name: 'zones_get', arguments: { zone_id: 'abc' } }, { Authorization: 'Bearer t' }),
    ),
  );

  assert.equal(calls[0]?.url, 'https://api.example.com/v1/zones/abc');
  assert.equal(calls[0]?.headers.get('Authorization'), 'Bearer t');
  assert.equal(body.result.isError, undefined);
  assert.deepEqual(JSON.parse(body.result.content[0].text), { success: true, result: { id: 'abc' } });
});

test('an API error is a tool result with isError, so the model sees it', async () => {
  const body = await result(
    await handler([], 403).fetch(
      mcp('tools/call', { name: 'zones_get', arguments: { zone_id: 'abc' } }, { Authorization: 'Bearer t' }),
    ),
  );

  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /^403/);
});

test('missing arguments and unknown tools are tool errors', async () => {
  const h = handler();
  const missing = await result(
    await h.fetch(mcp('tools/call', { name: 'zones_get', arguments: {} }, { Authorization: 'Bearer t' })),
  );
  const unknown = await result(await h.fetch(mcp('tools/call', { name: 'nope' }, { Authorization: 'Bearer t' })));

  assert.equal(missing.result.isError, true);
  assert.equal(missing.result.content[0].text, 'Missing required arguments: zone_id');
  assert.equal(unknown.result.isError, true);
  assert.equal(unknown.result.content[0].text, 'Unknown tool: nope');
});

test('authorize can refuse a request before it reaches MCP', async () => {
  const response = await handler().fetch(mcp('tools/list'));

  assert.equal(response.status, 401);
});

test('a catalogue in an unknown format is refused', async () => {
  const h = createForgeMcpHandler({ catalogue: () => ({ ...catalogue, format: 'forge-mcp/0' }) as never });

  await assert.rejects(h.fetch(mcp('tools/list')), /Not a forge-mcp\/1 catalogue/);
});
