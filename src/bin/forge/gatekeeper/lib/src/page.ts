import { isRecord } from './codec.js';
import type { RequestOptions, Result } from './transport.js';

/**
 * A link of a `Link` header.
 */
export interface Link {
  /**
   * The target of the link, as the API wrote it.
   */
  url: string;
  /**
   * The parameters of the link by name, in lower case: `rel`, and those of
   * the API.
   */
  params: { readonly [name: string]: string };
}

const LINK = /<([^>]*)>((?:\s*;\s*[^\s;=,"]+(?:\s*=\s*(?:"[^"]*"|[^\s;,"]*))?)*)\s*(?:,|$)/g;
const PARAM = /;\s*([^\s;=,"]+)(?:\s*=\s*(?:"([^"]*)"|([^\s;,"]*)))?/g;

/**
 * Returns the links of a `Link` header. What is not a link is left out.
 */
export function parseLinks(header: string | null): Link[] {
  const links: Link[] = [];
  for (const [, url, rest] of (header ?? '').matchAll(LINK)) {
    const params: { [name: string]: string } = {};
    for (const [, name, quoted, bare] of (rest ?? '').matchAll(PARAM)) {
      if (name !== undefined) {
        params[name.toLowerCase()] = quoted ?? bare ?? '';
      }
    }
    links.push({ url: url ?? '', params });
  }
  return links;
}

/**
 * One page of an operation that pages.
 */
export interface Page<Item, Next> {
  /**
   * The items of the page.
   */
  items: Item[];
  /**
   * What names the next page, or undefined when the page is the last. It
   * is JSON, so it can be kept in a cursor. A cursor that a caller gives
   * back is the caller's input: seal it, or check it.
   */
  next: Next | undefined;
}

/**
 * How an operation pages.
 */
export interface Pages<Request, Response, Item, Next> {
  /**
   * Returns the items of a result, and what names the page after it.
   * `request` is the request that got the result.
   */
  page(result: Result<Response>, request: Request): Page<Item, Next>;
  /**
   * Returns the request and the options that get the page `next` names,
   * for a first request. Without `next`, they get the first page.
   */
  resume(request: Request, next: Next | undefined): { request: Request; options: RequestOptions };
}

/**
 * What names the next page of an operation that pages by a `Link` header:
 * the query parameters of the `rel="next"` link.
 */
export type LinkNext = readonly (readonly [string, string])[];

type Step<T, K extends string> = T extends unknown ? (K extends keyof T ? T[K] : unknown) : never;
type At<T, P extends string> = P extends ''
  ? T
  : P extends `${infer Head}.${infer Rest}`
    ? At<Step<NonNullable<T>, Head>, Rest>
    : Step<NonNullable<T>, P>;

/**
 * The type of an item of the array at the path `P` of `T`, or of `T`
 * itself when the path is empty. It is `unknown` where `T` has no type
 * there.
 */
export type ItemOf<T, P extends string> = NonNullable<At<T, P>> extends readonly (infer Item)[] ? Item : unknown;

// Returns the value at a path of dots in a value, or undefined.
function dig(value: unknown, path: string | undefined): unknown {
  if (path === undefined || path === '') {
    return value;
  }
  let at = value;
  for (const name of path.split('.')) {
    if (!isRecord(at)) {
      return undefined;
    }
    at = at[name];
  }
  return at;
}

// Returns a copy of a request with a value at a path of dots.
function withField<T>(request: T, path: string, value: unknown): T {
  const dot = path.indexOf('.');
  const fields: { [name: string]: unknown } = isRecord(request) ? { ...request } : {};
  if (dot === -1) {
    fields[path] = value;
  } else {
    const head = path.slice(0, dot);
    fields[head] = withField(fields[head], path.slice(dot + 1), value);
  }
  return fields as T;
}

function itemsOf<Item>(data: unknown, path: string | undefined): Item[] {
  const items = dig(data, path);
  return Array.isArray(items) ? (items as Item[]) : [];
}

// Reports whether a response says that its page is the last.
function ended(data: unknown, spec: { more?: string; last?: string }): boolean {
  if (spec.more !== undefined && dig(data, spec.more) !== true) {
    return true;
  }
  return spec.last !== undefined && dig(data, spec.last) === true;
}

/**
 * Returns how an operation pages by a `Link` header. `items` is the path
 * of the items in a response, when it is not the array itself. `more` is
 * the parameter of the `rel="next"` link that is `true` when there is
 * another page, for an API that sends that link with the last page too.
 */
export function linkPages<Request, Response, P extends string = ''>(spec: {
  items?: P;
  more?: string;
}): Pages<Request, Response, ItemOf<Response, P>, LinkNext> {
  return {
    page(result) {
      const items = itemsOf<ItemOf<Response, P>>(result.data, spec.items);
      const link = parseLinks(result.headers.get('link')).find((found) =>
        (found.params['rel'] ?? '').toLowerCase().split(/\s+/).includes('next'),
      );
      if (link === undefined || (spec.more !== undefined && link.params[spec.more.toLowerCase()] !== 'true')) {
        return { items, next: undefined };
      }
      const start = link.url.indexOf('?');
      const query = start === -1 ? '' : (link.url.slice(start + 1).split('#')[0] ?? '');
      const next = [...new URLSearchParams(query)];
      // A link with no query names the same page again.
      return { items, next: next.length === 0 ? undefined : next };
    },
    resume(request, next) {
      // The query of the link replaces that of the request.
      return {
        request,
        options: next === undefined ? {} : { query: new URLSearchParams(next.map(([name, value]) => [name, value])) },
      };
    },
  };
}

/**
 * Returns how an operation pages by an offset. `offset` and `limit` are
 * the fields of the request. `more` is the path in a response of what is
 * true when there is another page, and `last` of what is true when the
 * page is the last. Without either, a page that is empty, or shorter than
 * the limit of the request, is the last.
 */
export function offsetPages<Request, Response, P extends string = ''>(spec: {
  items?: P;
  offset: string;
  limit?: string;
  more?: string;
  last?: string;
}): Pages<Request, Response, ItemOf<Response, P>, number> {
  return {
    page(result, request) {
      const items = itemsOf<ItemOf<Response, P>>(result.data, spec.items);
      if (items.length === 0 || ended(result.data, spec)) {
        return { items, next: undefined };
      }
      if (spec.more === undefined && spec.last === undefined) {
        const limit = dig(request, spec.limit === undefined ? 'limit' : spec.limit);
        if (typeof limit === 'number' && items.length < limit) {
          return { items, next: undefined };
        }
      }
      const offset = dig(request, spec.offset);
      return { items, next: (typeof offset === 'number' ? offset : 0) + items.length };
    },
    resume(request, next) {
      return { request: next === undefined ? request : withField(request, spec.offset, next), options: {} };
    },
  };
}

/**
 * Returns how an operation pages by a cursor. `cursor` is the field of
 * the request, and `next` the path in a response of the cursor of the
 * next page. `more` and `last` are as for an offset. A response with no
 * cursor is the last page.
 */
export function cursorPages<Request, Response, P extends string = ''>(spec: {
  items?: P;
  cursor: string;
  next: string;
  more?: string;
  last?: string;
}): Pages<Request, Response, ItemOf<Response, P>, string> {
  return {
    page(result) {
      const items = itemsOf<ItemOf<Response, P>>(result.data, spec.items);
      const cursor = dig(result.data, spec.next);
      const next = typeof cursor === 'number' ? String(cursor) : cursor;
      if (typeof next !== 'string' || next === '' || ended(result.data, spec)) {
        return { items, next: undefined };
      }
      return { items, next };
    },
    resume(request, next) {
      return { request: next === undefined ? request : withField(request, spec.cursor, next), options: {} };
    },
  };
}
