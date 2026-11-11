import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { cursorPages, linkPages, offsetPages, parseLinks } from '../src/page.js';
import type { Result } from '../src/transport.js';

function result<T>(data: T, headers: HeadersInit = {}): Result<T> {
  return { data, status: 200, headers: new Headers(headers) };
}

function nextLink(results: string): HeadersInit {
  return { link: `</items?cursor=1>; rel="next"; results="${results}"` };
}

describe('parseLinks', () => {
  test('returns each link with its parameters', () => {
    const header =
      '<https://a.test/items?cursor=0:0:1>; rel="previous"; results="false", ' +
      '<https://a.test/items?cursor=0:100:0&q=a,b>; rel="next"; results="true"; cursor="0:100:0"';
    assert.deepEqual(parseLinks(header), [
      { url: 'https://a.test/items?cursor=0:0:1', params: { rel: 'previous', results: 'false' } },
      {
        url: 'https://a.test/items?cursor=0:100:0&q=a,b',
        params: { rel: 'next', results: 'true', cursor: '0:100:0' },
      },
    ]);
  });

  test('reads a parameter with no quotes, and names in any case', () => {
    assert.deepEqual(parseLinks('</items?page=2>; REL=next'), [{ url: '/items?page=2', params: { rel: 'next' } }]);
  });

  test('has no links for a header that is missing or is not one', () => {
    assert.deepEqual(parseLinks(null), []);
    assert.deepEqual(parseLinks('next'), []);
  });
});

describe('linkPages', () => {
  const pages = linkPages<{ q?: string }, { id: number }[]>({});

  test('the next page is the query of the rel="next" link', () => {
    const page = pages.page(
      result([{ id: 1 }], { link: '<https://a.test/items?page=2&s%5B%5D=a&s%5B%5D=b>; rel="next"' }),
      {},
    );
    assert.deepEqual(page.items, [{ id: 1 }]);
    assert.deepEqual(page.next, [
      ['page', '2'],
      ['s[]', 'a'],
      ['s[]', 'b'],
    ]);
    // It is JSON, and the query of the next request.
    const next = JSON.parse(JSON.stringify(page.next)) as typeof page.next;
    const { request, options } = pages.resume({ q: 'x' }, next);
    assert.deepEqual(request, { q: 'x' });
    assert.equal(options.query?.toString(), 'page=2&s%5B%5D=a&s%5B%5D=b');
  });

  test('a page with no rel="next" link is the last', () => {
    assert.equal(pages.page(result([{ id: 1 }], { link: '</items?page=1>; rel="prev"' }), {}).next, undefined);
    assert.equal(pages.page(result([{ id: 1 }]), {}).next, undefined);
    // A link with no query would get the same page again.
    assert.equal(pages.page(result([{ id: 1 }], { link: '</items>; rel="next"' }), {}).next, undefined);
  });

  test('a link can say that there is no other page', () => {
    const marked = linkPages<object, { id: number }[]>({ more: 'results' });
    assert.deepEqual(marked.page(result([], nextLink('true')), {}).next, [['cursor', '1']]);
    assert.equal(marked.page(result([], nextLink('false')), {}).next, undefined);
    assert.equal(marked.page(result([], { link: '</items?cursor=1>; rel="next"' }), {}).next, undefined);
  });

  test('the items can be a property, and the first page has no options', () => {
    const nested = linkPages<object, { runs: { id: number }[] }, 'runs'>({ items: 'runs' });
    const page = nested.page(result({ runs: [{ id: 1 }] }), {});
    const id: number | undefined = page.items[0]?.id;
    assert.equal(id, 1);
    assert.deepEqual(nested.resume({}, undefined), { request: {}, options: {} });
  });
});

describe('offsetPages', () => {
  interface Request {
    offset?: number;
    limit?: number;
  }
  interface Response {
    items: string[];
    more?: boolean;
  }

  test('the next offset is past the items of the page', () => {
    const pages = offsetPages<Request, Response, 'items'>({ items: 'items', offset: 'offset', more: 'more' });
    const page = pages.page(result({ items: ['a', 'b'], more: true }), { offset: 4 });
    assert.equal(page.next, 6);
    assert.deepEqual(pages.resume({ limit: 2 }, page.next), { request: { limit: 2, offset: 6 }, options: {} });
    assert.equal(pages.page(result({ items: ['a'], more: false }), {}).next, undefined);
    assert.equal(pages.page(result({ items: ['a'] }), {}).next, undefined);
  });

  test('a response can say that its page is the last', () => {
    const pages = offsetPages<Request, { values: string[]; isLast: boolean }, 'values'>({
      items: 'values',
      offset: 'offset',
      last: 'isLast',
    });
    assert.equal(pages.page(result({ values: ['a'], isLast: false }), {}).next, 1);
    assert.equal(pages.page(result({ values: ['a'], isLast: true }), {}).next, undefined);
  });

  test('without either, a short or an empty page is the last', () => {
    const pages = offsetPages<Request, string[]>({ offset: 'offset', limit: 'limit' });
    assert.equal(pages.page(result(['a', 'b']), { limit: 2 }).next, 2);
    assert.equal(pages.page(result(['a']), { limit: 2 }).next, undefined);
    assert.equal(pages.page(result(['a']), {}).next, 1);
    assert.equal(pages.page(result([]), {}).next, undefined);
  });
});

describe('cursorPages', () => {
  test('the next cursor is a property of the response, and a field of the request', () => {
    const pages = cursorPages<
      { channel: string; cursor?: string },
      { messages: string[]; meta: { next: string } },
      'messages'
    >({ items: 'messages', cursor: 'cursor', next: 'meta.next' });
    const page = pages.page(result({ messages: ['a'], meta: { next: 'c2' } }), { channel: 'x' });
    assert.deepEqual(page, { items: ['a'], next: 'c2' });
    assert.deepEqual(pages.resume({ channel: 'x' }, page.next).request, { channel: 'x', cursor: 'c2' });
    assert.equal(pages.page(result({ messages: [], meta: { next: '' } }), { channel: 'x' }).next, undefined);
  });

  test('the cursor can be a field of the body, and a response can have no type', () => {
    const pages = cursorPages<{ body?: { start_cursor?: string; filter?: string } }, unknown, 'results'>({
      items: 'results',
      cursor: 'body.start_cursor',
      next: 'next_cursor',
      more: 'has_more',
    });
    const page = pages.page(result<unknown>({ results: [1], next_cursor: 'n', has_more: true }), {});
    assert.deepEqual(page, { items: [1], next: 'n' });
    assert.deepEqual(pages.resume({ body: { filter: 'f' } }, 'n').request, {
      body: { filter: 'f', start_cursor: 'n' },
    });
    assert.equal(pages.page(result<unknown>({ results: [1], next_cursor: 'n', has_more: false }), {}).next, undefined);
    assert.deepEqual(pages.page(result<unknown>('no'), {}), { items: [], next: undefined });
  });
});
