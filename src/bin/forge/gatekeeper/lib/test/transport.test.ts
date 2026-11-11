import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { object } from '../src/codec.js';
import { ApiError, DecodeError } from '../src/error.js';
import {
  type BaseClientOptions,
  type Operation,
  type ProviderRequest,
  type ProviderResponse,
  Transport,
} from '../src/transport.js';

// Returns a transport whose provider answers with responses in turn, and
// the requests it got.
function fake(...responses: ProviderResponse[]): { transport: Transport; requests: ProviderRequest[] } {
  return fakeWith({}, ...responses);
}

function fakeWith(
  options: Partial<BaseClientOptions>,
  ...responses: ProviderResponse[]
): { transport: Transport; requests: ProviderRequest[] } {
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
    ...options,
  });
  return { transport, requests };
}

function response(text: string, status = 200, headers: HeadersInit = {}): ProviderResponse {
  return { status, headers: new Headers(headers), text };
}

function json(body: unknown, status = 200, headers: HeadersInit = {}): ProviderResponse {
  return response(JSON.stringify(body), status, headers);
}

const get: Operation = {
  id: 'repos/get-content',
  kind: 'read',
  method: 'GET',
  route: '/repos/{owner}/{repo}/contents/{path}',
  query: { perPage: 'per_page', labels: 'labels', ids: 'ids' },
  joined: ['labels'],
  response: object([['html_url', 'htmlUrl']]),
  errors: { '404': object([['documentation_url', 'documentationUrl']]), '304': false },
};

const create: Operation = {
  id: 'issues/create',
  kind: 'write',
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

  test('gives the provider the operation, the route, the parameters, the path and the query', async () => {
    const { transport, requests } = fake(json({}));
    await transport.send(
      get,
      { owner: 'a b', repo: 'r', path: 'src/x.ts', perPage: 2, labels: ['x', 'y'], ids: [1, 2] },
      { query: new URLSearchParams({ extra: '1' }) },
    );
    const [request] = requests;
    assert.equal(request?.operationId, 'repos/get-content');
    assert.equal(request?.kind, 'read');
    assert.equal(request?.method, 'GET');
    assert.equal(request?.route, '/repos/{owner}/{repo}/contents/{path}');
    assert.deepEqual(request?.params, { owner: 'a b', repo: 'r', path: 'src/x.ts' });
    assert.equal(request?.path, '/repos/a%20b/r/contents/src%2Fx.ts');
    assert.equal(request?.query.toString(), 'per_page=2&labels=x%2Cy&ids=1&ids=2&extra=1');
    assert.equal(request?.body, undefined);
  });

  test('a query parameter of the call replaces that of the request', async () => {
    const { transport, requests } = fake(json({}));
    const query = new URLSearchParams([
      ['ids', '7'],
      ['ids', '8'],
    ]);
    await transport.send(get, { owner: 'o', repo: 'r', path: 'p', perPage: 2, ids: [1, 2] }, { query });
    assert.equal(requests[0]?.query.toString(), 'per_page=2&ids=7&ids=8');
  });

  test('sends the headers of the client, then of the call, and no credentials or accept', async () => {
    const { transport, requests } = fake(json({}));
    await transport.send(
      get,
      { owner: 'o', repo: 'r', path: 'p' },
      { headers: { 'x-client': 'b', 'if-none-match': '"e"' } },
    );
    const headers = requests[0]?.headers;
    assert.equal(headers?.has('accept'), false);
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

  test("a path parameter a connection is bound to is the client's", async () => {
    const { transport, requests } = fakeWith({ bound: { owner: 'mine' } }, json({}), json({}));
    await transport.send(get, { repo: 'r', path: 'p' }, undefined);
    assert.equal(requests[0]?.params['owner'], 'mine');
    assert.ok(requests[0]?.path.startsWith('/repos/mine/r/'), requests[0]?.path);
    // A request cannot say another.
    await transport.send(get, { owner: 'theirs', repo: 'r', path: 'p' }, undefined);
    assert.equal(requests[1]?.params['owner'], 'mine');
  });

  test('a path parameter is required', async () => {
    const { transport } = fake();
    await assert.rejects(transport.send(get, { owner: 'o', path: 'p' }, undefined), new TypeError('repo is required'));
  });

  test('a path parameter cannot be a dot segment', async () => {
    const { transport, requests } = fake();
    for (const repo of ['.', '..']) {
      await assert.rejects(
        transport.send(get, { owner: 'o', repo, path: 'p' }, undefined),
        new TypeError(`repo cannot be "${repo}"`),
      );
    }
    assert.equal(requests.length, 0);
  });

  test('a path parameter with a dot segment inside it is encoded', async () => {
    const { transport, requests } = fake(json({}), json({}));
    await transport.send(get, { owner: 'o', repo: 'r', path: '../x' }, undefined);
    await transport.send(get, { owner: 'o', repo: 'r', path: '%2e%2e' }, undefined);
    assert.equal(requests[0]?.path, '/repos/o/r/contents/..%2Fx');
    assert.equal(requests[1]?.path, '/repos/o/r/contents/%252e%252e');
  });

  test('encodes the body, without the parameters', async () => {
    const { transport, requests } = fake(json({ id: 1 }, 201));
    const result = await transport.send(create, { owner: 'o', repo: 'r', issueTitle: 't' }, undefined);
    assert.equal(requests[0]?.body, '{"issue_title":"t"}');
    assert.equal(requests[0]?.headers.get('content-type'), 'application/json');
    assert.deepEqual(result.data, { id: 1 });
    assert.equal(result.status, 201);
  });

  test('returns the decoded body with the status and the headers', async () => {
    const { transport } = fake(
      json({ html_url: 'u' }, 200, { etag: '"e"', link: '<https://api.test/x?page=2>; rel="next"' }),
    );
    const result = await transport.send(get, { owner: 'o', repo: 'r', path: 'p' }, undefined);
    assert.deepEqual(result.data, { htmlUrl: 'u' });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('etag'), '"e"');
    assert.equal(result.headers.get('link'), '<https://api.test/x?page=2>; rel="next"');
  });

  test('a response without a body has no data', async () => {
    const { transport } = fake(response('', 204), response('', 200));
    const request = { owner: 'o', repo: 'r', path: 'p' };
    const result = await transport.send(get, request, undefined);
    assert.equal(result.data, undefined);
    assert.equal(result.status, 204);
    // An operation that declares no body may have none with any status.
    const none: Operation = { id: 'repos/star', kind: 'write', method: 'PUT', route: '/starred/{owner}/{repo}' };
    assert.equal((await transport.send(none, request, undefined)).status, 200);
  });

  test('an empty body where the operation declares one is thrown', async () => {
    const { transport } = fake(response('', 200));
    await assert.rejects(transport.send(get, { owner: 'o', repo: 'r', path: 'p' }, undefined), DecodeError);
  });

  test('an empty body of a write that declares one is not thrown, since the change was made', async () => {
    const { transport } = fake(response('', 201), response('<html>', 201));
    const write: Operation = { id: 'issues/snooze', kind: 'write', method: 'POST', route: '/snooze', response: null };
    const result = await transport.send(write, undefined, undefined);
    assert.equal(result.status, 201);
    assert.equal(result.data, undefined);
    // A body that is not JSON is still not what the operation declares.
    await assert.rejects(transport.send(write, undefined, undefined), DecodeError);
  });

  test('a JSON error body is given parsed, whether or not the operation declares the status', async () => {
    const { transport } = fake(json({ error: { message: 'no' } }, 500));
    await assert.rejects(transport.send(get, { owner: 'o', repo: 'r', path: 'p' }, undefined), (error) => {
      assert.ok(error instanceof ApiError);
      assert.deepEqual(error.details, { error: { message: 'no' } });
      return true;
    });
  });

  test('a status that is not a number is not a success', async () => {
    const { transport } = fake(json({}, Number.NaN), json({}, '200' as never));
    const request = { owner: 'o', repo: 'r', path: 'p' };
    await assert.rejects(transport.send(get, request, undefined), ApiError);
    await assert.rejects(transport.send(get, request, undefined), ApiError);
  });

  test('an error function that returns no error leaves the ApiError', async () => {
    const { transport } = fakeWith({ error: () => undefined as never }, json({ message: 'Not Found' }, 404));
    await assert.rejects(transport.send(get, { owner: 'o', repo: 'r', path: 'p' }, undefined), ApiError);
  });

  test('an error response is thrown, with its body decoded', async () => {
    const { transport } = fake(json({ message: 'Not Found', documentation_url: 'd' }, 404, { 'x-request': '1' }));
    await assert.rejects(transport.send(get, { owner: 'o', repo: 'r', path: 'p' }, undefined), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.message, 'repos/get-content: status 404: Not Found');
      assert.equal(error.operationId, 'repos/get-content');
      assert.equal(error.status, 404);
      assert.equal(error.source, 'status');
      assert.equal(error.headers.get('x-request'), '1');
      assert.deepEqual(error.details, { message: 'Not Found', documentationUrl: 'd' });
      assert.equal('response' in error, false);
      return true;
    });
  });

  test('the message of an error is bounded, and is the status alone without a message', async () => {
    const { transport } = fake(json({ message: 'x'.repeat(500) }, 422), response('<html>secret</html>', 502));
    const request = { owner: 'o', repo: 'r', path: 'p' };
    await assert.rejects(transport.send(get, request, undefined), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.message, `repos/get-content: status 422: ${'x'.repeat(200)}…`);
      return true;
    });
    await assert.rejects(transport.send(get, request, undefined), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.message, 'repos/get-content: status 502');
      assert.equal(error.details, '<html>secret</html>');
      return true;
    });
  });

  test('the client can say what error is thrown', async () => {
    class Mine extends Error {
      readonly status: number;

      constructor(status: number) {
        super('mine');
        this.status = status;
      }
    }
    const { transport } = fakeWith(
      {
        error: (failure) => {
          assert.equal(failure.operationId, 'repos/get-content');
          assert.equal(failure.message, 'Not Found');
          assert.deepEqual(failure.details, { message: 'Not Found' });
          return new Mine(failure.status);
        },
      },
      json({ message: 'Not Found' }, 404),
    );
    await assert.rejects(transport.send(get, { owner: 'o', repo: 'r', path: 'p' }, undefined), (error) => {
      assert.ok(error instanceof Mine);
      assert.equal(error.status, 404);
      return true;
    });
  });

  test('a 2XX response whose body says it failed is thrown', async () => {
    const list: Operation = {
      id: 'conversations_history',
      kind: 'read',
      method: 'GET',
      route: '/conversations.history',
      response: null,
      failure: { property: 'ok', equals: false },
    };
    const { transport } = fake(json({ ok: false, error: 'channel_not_found' }), json({ ok: true, messages: [] }));
    await assert.rejects(transport.send(list, {}, undefined), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.message, 'conversations_history: status 200: channel_not_found');
      assert.equal(error.status, 200);
      assert.equal(error.source, 'body');
      assert.deepEqual(error.details, { ok: false, error: 'channel_not_found' });
      return true;
    });
    const result = await transport.send(list, {}, undefined);
    assert.deepEqual(result.data, { ok: true, messages: [] });
    // An operation without a body can fail in its body too.
    const post: Operation = { ...list, id: 'reactions_add', kind: 'write', method: 'POST' };
    delete post.response;
    const other = fake(json({ ok: false, error: 'already_reacted' }), response('ok'));
    await assert.rejects(other.transport.send(post, {}, undefined), ApiError);
    assert.equal((await other.transport.send(post, {}, undefined)).status, 200);
  });

  test('a 304 is thrown, with its headers', async () => {
    const { transport } = fake(response('', 304, { etag: '"e"' }));
    await assert.rejects(transport.send(get, { owner: 'o', repo: 'r', path: 'p' }, undefined), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 304);
      assert.equal(error.headers.get('etag'), '"e"');
      return true;
    });
  });

  test('a 304 of a conditional operation is returned', async () => {
    const { transport } = fake(response('', 304, { etag: '"e"' }), json({ html_url: 'u' }));
    const request = { owner: 'o', repo: 'r', path: 'p' };
    const cached = await transport.sendConditional<{ htmlUrl: string }>(get, request, undefined);
    assert.equal(cached.notModified, true);
    assert.equal(cached.status, 304);
    assert.equal(cached.headers.get('etag'), '"e"');
    const fresh = await transport.sendConditional<{ htmlUrl: string }>(get, request, undefined);
    assert.ok(!fresh.notModified);
    assert.deepEqual(fresh.data, { htmlUrl: 'u' });
  });

  test('a success body that is not JSON is thrown without a status or the body', async () => {
    const { transport } = fake(response('<html>secret</html>'));
    await assert.rejects(transport.send(get, { owner: 'o', repo: 'r', path: 'p' }, undefined), (error) => {
      assert.ok(error instanceof DecodeError);
      assert.equal(error.message, 'repos/get-content: the response body is not what the operation declares');
      assert.equal('status' in error, false);
      assert.equal(error.cause, undefined);
      return true;
    });
  });
});
