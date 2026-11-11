import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  fetchProvider,
  reasonMessage,
  reasonOf,
  ResponseTooLargeError,
  retryAfterSeconds,
  serverUrl,
  UnreachableError,
} from '../src/provider.js';
import type { ProviderRequest } from '../src/transport.js';

function request(fields: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    operationId: 'issues/list',
    kind: 'read',
    method: 'GET',
    route: '/orgs/{org}/issues',
    params: { org: 'o' },
    path: '/orgs/o/issues',
    query: new URLSearchParams('q=a'),
    headers: new Headers({ 'x-client': 'a' }),
    ...fields,
  };
}

interface Sent {
  url: string;
  init: RequestInit;
}

// Returns a fetch that answers with `response`, and what it was sent.
function fake(response: () => Response): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: async (url, init) => {
      sent.push({ url: String(url), init: init ?? {} });
      return response();
    },
  };
}

const bearer = ({ headers }: { headers: Headers }): void => {
  headers.set('authorization', 'Bearer t');
};

describe('fetchProvider', () => {
  test('sends a request under the base URL, with the credential', async () => {
    const { fetch, sent } = fake(() => new Response('{"a":1}', { status: 200, headers: { etag: '"e"' } }));
    const provider = fetchProvider({ baseUrl: 'https://api.test/v1/', authorize: bearer, fetch });
    const response = await provider.send(request());
    assert.equal(response.status, 200);
    assert.equal(response.text, '{"a":1}');
    assert.equal(response.headers.get('etag'), '"e"');
    assert.equal(sent[0]?.url, 'https://api.test/v1/orgs/o/issues?q=a');
    const headers = new Headers(sent[0]?.init.headers);
    assert.equal(headers.get('authorization'), 'Bearer t');
    assert.equal(headers.get('accept'), 'application/json');
    assert.equal(headers.get('x-client'), 'a');
    assert.equal(sent[0]?.init.redirect, 'manual');
    assert.equal(sent[0]?.init.method, 'GET');
  });

  test('a credential can be a query parameter, and a call cannot replace it', async () => {
    const { fetch, sent } = fake(() => new Response('{}'));
    const provider = fetchProvider({
      baseUrl: 'https://api.test',
      authorize: ({ headers, query }) => {
        headers.set('authorization', 'Bearer t');
        query.set('key', 'k');
      },
      accept: 'application/vnd.t+json',
      fetch,
    });
    await provider.send(
      request({ headers: new Headers({ authorization: 'Bearer theirs' }), query: new URLSearchParams('key=theirs') }),
    );
    assert.equal(sent[0]?.url, 'https://api.test/orgs/o/issues?key=k');
    const headers = new Headers(sent[0]?.init.headers);
    assert.equal(headers.get('authorization'), 'Bearer t');
    assert.equal(headers.get('accept'), 'application/vnd.t+json');
  });

  test('refuses a write, unless it is said to write', async () => {
    const { fetch, sent } = fake(() => new Response('{}'));
    const reads = fetchProvider({ baseUrl: 'https://api.test', authorize: bearer, fetch });
    const write = request({ kind: 'write', method: 'POST', body: '{}' });
    await assert.rejects(reads.send(write), new TypeError('issues/list: a provider of reads cannot send a write'));
    // The kind is what the config says, so the method is checked too.
    await assert.rejects(reads.send(request({ method: 'DELETE' })), TypeError);
    assert.equal(sent.length, 0);
    await reads.send(request({ method: 'POST', body: '{}' }));
    const writes = fetchProvider({ baseUrl: 'https://api.test', authorize: bearer, fetch, writes: true });
    await writes.send(write);
    assert.equal(sent[1]?.init.body, '{}');
  });

  test('does not follow a redirect, and does not read its body', async () => {
    const { fetch } = fake(() => new Response('secret', { status: 302, headers: { location: 'https://b.test' } }));
    const provider = fetchProvider({ baseUrl: 'https://api.test', authorize: bearer, fetch });
    const response = await provider.send(request());
    assert.equal(response.status, 302);
    assert.equal(response.text, '');
  });

  test('reads no more of a body than its limit', async () => {
    const { fetch } = fake(() => new Response('0123456789'));
    const provider = fetchProvider({ baseUrl: 'https://api.test', authorize: bearer, fetch, maxResponseBytes: 9 });
    await assert.rejects(provider.send(request()), ResponseTooLargeError);
    const declared = fake(() => new Response('', { headers: { 'content-length': '10' } }));
    const other = fetchProvider({
      baseUrl: 'https://api.test',
      authorize: bearer,
      fetch: declared.fetch,
      maxResponseBytes: 9,
    });
    await assert.rejects(other.send(request()), ResponseTooLargeError);
  });

  test('a request with no response has no status', async () => {
    const provider = fetchProvider({
      baseUrl: 'https://api.test',
      authorize: bearer,
      fetch: async () => {
        throw new TypeError('network');
      },
    });
    await assert.rejects(provider.send(request()), (error: unknown) => {
      assert.ok(error instanceof UnreachableError);
      assert.equal(error.message, 'issues/list: the API could not be reached');
      assert.equal('status' in error, false);
      return true;
    });
  });

  test('needs a base URL that is https, with no query', () => {
    const options = { authorize: bearer };
    assert.throws(() => fetchProvider({ ...options, baseUrl: 'http://api.test' }), TypeError);
    assert.throws(() => fetchProvider({ ...options, baseUrl: 'https://api.test?a=1' }), TypeError);
    assert.throws(() => fetchProvider({ ...options, baseUrl: 'https://u:p@api.test' }), TypeError);
    fetchProvider({ ...options, baseUrl: 'http://localhost:8787' });
  });
});

describe('reasonOf', () => {
  test('is what the status says', () => {
    const reasons = [400, 401, 403, 404, 409, 410, 412, 422, 429, 500, 503, 302, 200].map((status) =>
      reasonOf({ status }),
    );
    assert.deepEqual(reasons, [
      'invalid',
      'credential',
      'denied',
      'missing',
      'conflict',
      'missing',
      'conflict',
      'invalid',
      'rate-limit',
      'unavailable',
      'unavailable',
      'other',
      'other',
    ]);
  });

  test('a rule says what the provider documents otherwise', () => {
    assert.equal(reasonOf({ status: 404 }, { 404: 'denied' }), 'denied');
    assert.equal(reasonOf({ status: 403 }, { 404: 'denied' }), 'denied');
    assert.equal(reasonOf({ status: 200 }, { 200: 'invalid' }), 'invalid');
  });
});

describe('retryAfterSeconds', () => {
  test('reads seconds or a date', () => {
    assert.equal(retryAfterSeconds(new Headers({ 'retry-after': '120' })), 120);
    const now = Date.parse('2026-01-01T00:00:00Z');
    assert.equal(retryAfterSeconds(new Headers({ 'retry-after': 'Thu, 01 Jan 2026 00:00:30 GMT' }), now), 30);
    assert.equal(retryAfterSeconds(new Headers({ 'retry-after': 'Thu, 01 Jan 2015 00:00:30 GMT' }), now), 0);
    assert.equal(retryAfterSeconds(new Headers({ 'retry-after': 'soon' })), undefined);
    assert.equal(retryAfterSeconds(new Headers()), undefined);
  });
});

test('reasonMessage has the name of the provider and nothing it sent', () => {
  assert.equal(reasonMessage('credential', 'Example'), "Example rejected the connection's credential.");
  assert.equal(reasonMessage('other', 'Example'), 'Example could not answer the request.');
});

describe('serverUrl', () => {
  const variables = { region: { default: 'us', values: ['us', 'de'] }, tenant: {} };
  const template = 'https://{tenant}.{region}.example.com';

  test('fills in each variable, or its default', () => {
    assert.equal(serverUrl(template, variables, { tenant: 'acme' }), 'https://acme.us.example.com');
    assert.equal(serverUrl(template, variables, { tenant: 'acme', region: 'de' }), 'https://acme.de.example.com');
  });

  test('refuses a value that could name another host', () => {
    assert.throws(() => serverUrl(template, variables), new TypeError('serverUrl: tenant is required'));
    assert.throws(() => serverUrl(template, variables, { tenant: 'acme', region: 'eu' }), TypeError);
    assert.throws(() => serverUrl(template, variables, { tenant: 'evil.test/' }), TypeError);
    assert.throws(() => serverUrl(template, variables, { tenant: 'a@b' }), TypeError);
    assert.throws(() => serverUrl(template, variables, { tenant: '' }), TypeError);
  });
});
