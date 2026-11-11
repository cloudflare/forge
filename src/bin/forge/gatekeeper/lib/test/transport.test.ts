import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { object } from '../src/codec.js';
import { ApiError } from '../src/error.js';
import { type Operation, type ProviderRequest, Transport } from '../src/transport.js';

// Returns a transport whose provider answers with responses in turn, and
// the requests it got.
function fake(...responses: Response[]): { transport: Transport; requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  const transport = new Transport({
    provider: {
      async send(request) {
        requests.push(request);
        const next = responses.shift();
        assert.ok(next !== undefined, `unexpected request to ${request.path}`);
        return next;
      },
    },
    headers: { 'x-client': 'a' },
  });
  return { transport, requests };
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

const get: Operation = {
  method: 'GET',
  route: '/repos/{owner}/{repo}/contents/{path}',
  query: { perPage: 'per_page', labels: 'labels', ids: 'ids' },
  joined: ['labels'],
  response: object([['html_url', 'htmlUrl']]),
  errors: { '404': object([['documentation_url', 'documentationUrl']]), '304': false },
};

const create: Operation = {
  method: 'POST',
  route: '/repos/{owner}/{repo}/issues',
  body: 'flat',
  request: object([['issue_title', 'issueTitle']]),
  response: null,
};

describe('Transport', () => {
  test('needs a provider', () => {
    assert.throws(() => new Transport({} as never), new TypeError('createClient: provider is required'));
  });

  test('gives the provider the route, the parameters and the path', async () => {
    const { transport, requests } = fake(json({}));
    await transport.send(
      get,
      { owner: 'a b', repo: 'r', path: 'src/x.ts', perPage: 2, labels: ['x', 'y'], ids: [1, 2] },
      { query: new URLSearchParams({ extra: '1' }) },
    );
    const [request] = requests;
    assert.equal(request?.method, 'GET');
    assert.equal(request?.route, '/repos/{owner}/{repo}/contents/{path}');
    assert.deepEqual(request?.params, { owner: 'a b', repo: 'r', path: 'src/x.ts' });
    assert.equal(request?.path, '/repos/a%20b/r/contents/src%2Fx.ts?per_page=2&labels=x%2Cy&ids=1&ids=2&extra=1');
    assert.equal(request?.body, undefined);
  });

  test('sends the headers of the client, then of the call, and no credentials', async () => {
    const { transport, requests } = fake(json({}));
    await transport.send(
      get,
      { owner: 'o', repo: 'r', path: 'p' },
      { headers: { 'x-client': 'b', 'if-none-match': '"e"' } },
    );
    const headers = requests[0]?.headers;
    assert.equal(headers?.get('accept'), 'application/json');
    assert.equal(headers?.get('x-client'), 'b');
    assert.equal(headers?.get('if-none-match'), '"e"');
    assert.equal(headers?.has('authorization'), false);
  });

  test('passes the signal on', async () => {
    const { transport, requests } = fake(json({}));
    const { signal } = new AbortController();
    await transport.send(get, { owner: 'o', repo: 'r', path: 'p' }, { signal });
    assert.equal(requests[0]?.signal, signal);
  });

  test('a path parameter is required', async () => {
    const { transport } = fake();
    await assert.rejects(transport.send(get, { owner: 'o', path: 'p' }, undefined), new TypeError('repo is required'));
  });

  test('encodes the body, without the parameters', async () => {
    const { transport, requests } = fake(json({ id: 1 }, { status: 201 }));
    const result = await transport.send(create, { owner: 'o', repo: 'r', issueTitle: 't' }, undefined);
    assert.equal(requests[0]?.body, '{"issue_title":"t"}');
    assert.equal(requests[0]?.headers.get('content-type'), 'application/json');
    assert.deepEqual(result.data, { id: 1 });
    assert.equal(result.status, 201);
  });

  test('returns the decoded body with the status and the headers', async () => {
    const { transport } = fake(
      json({ html_url: 'u' }, { headers: { etag: '"e"', link: '<https://api.test/x?page=2>; rel="next"' } }),
    );
    const result = await transport.send(get, { owner: 'o', repo: 'r', path: 'p' }, undefined);
    assert.deepEqual(result.data, { htmlUrl: 'u' });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('etag'), '"e"');
    assert.equal(result.headers.get('link'), '<https://api.test/x?page=2>; rel="next"');
  });

  test('a response without a body has no data', async () => {
    const { transport } = fake(new Response(null, { status: 204 }));
    const result = await transport.send(get, { owner: 'o', repo: 'r', path: 'p' }, undefined);
    assert.equal(result.data, undefined);
    assert.equal(result.status, 204);
  });

  test('an error response is thrown, with its body decoded', async () => {
    const { transport } = fake(json({ message: 'Not Found', documentation_url: 'd' }, { status: 404 }));
    await assert.rejects(transport.send(get, { owner: 'o', repo: 'r', path: 'p' }, undefined), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.message, 'Not Found');
      assert.equal(error.status, 404);
      assert.deepEqual(error.details, { message: 'Not Found', documentationUrl: 'd' });
      return true;
    });
  });

  test('a 304 is thrown, with its headers', async () => {
    const { transport } = fake(new Response(null, { status: 304, headers: { etag: '"e"' } }));
    await assert.rejects(transport.send(get, { owner: 'o', repo: 'r', path: 'p' }, undefined), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 304);
      assert.equal(error.response.headers.get('etag'), '"e"');
      return true;
    });
  });

  test('a body that is not JSON is thrown', async () => {
    const { transport } = fake(new Response('<html>'));
    await assert.rejects(transport.send(get, { owner: 'o', repo: 'r', path: 'p' }, undefined), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.message, 'the response body is not valid JSON');
      return true;
    });
  });
});
