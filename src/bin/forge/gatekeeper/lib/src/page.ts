import { isRecord } from './codec.js';
import type { NotModified, RequestOptions, Result } from './transport.js';

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

// Each matches at one place and goes on from where the one before ended,
// so a header is read once, whatever it holds.
const TARGET = /<([^>]*)>/y;
const PARAM = /\s*;\s*([^\s;=,"]+)(?:\s*=\s*(?:"([^"]*)"|([^\s;,"]*)))?/y;

// The longest `Link` header that is read.
const MAX_LINK_LENGTH = 16 * 1024;

/**
 * Returns the links of a `Link` header. What is not a link is left out,
 * and so is all of a header that is longer than 16,384 characters.
 *
 * @param header The value of the header, or null when the response has none.
 * @returns The links, in the order of the header.
 */
export function parseLinks(header: string | null): Link[] {
  const links: Link[] = [];
  if (header === null || header.length > MAX_LINK_LENGTH) {
    return links;
  }
  for (let at = header.indexOf('<'); at !== -1; at = header.indexOf('<', at)) {
    TARGET.lastIndex = at;
    const target = TARGET.exec(header);
    if (target === null) {
      break;
    }
    at = TARGET.lastIndex;
    const params: { [name: string]: string } = {};
    for (;;) {
      PARAM.lastIndex = at;
      const [, name, quoted, bare] = PARAM.exec(header) ?? [];
      if (name === undefined) {
        break;
      }
      at = PARAM.lastIndex;
      params[name.toLowerCase()] = quoted ?? bare ?? '';
    }
    links.push({ url: target[1] ?? '', params });
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
   *
   * @param result The result of a call of the operation.
   * @param request The request that got it.
   * @returns The items of the page, and what names the next page.
   */
  page(result: Result<Response>, request: Request): Page<Item, Next>;
  /**
   * Returns the request and the options that get the page `next` names,
   * for a first request. Without `next`, they get the first page.
   *
   * @param request The first request of the listing.
   * @param next What a page before gave as its `next`, or undefined for the first page.
   * @returns The request and the options to call the operation with.
   */
  resume(request: Request, next: Next | undefined): { request: Request; options: RequestOptions };
}

/**
 * A page that a pager got from the client: its items, what names the page
 * after it, and the result they are from.
 */
export interface FetchedPage<Response, Item, Next> extends Page<Item, Next> {
  /**
   * The result of the call, for its status and its headers.
   */
  result: Result<Response>;
  /**
   * Never set. It tells a page from a NotModified.
   */
  notModified?: undefined;
}

/**
 * A pager that also calls its operation. `Got` is what the operation
 * returns, which for a conditional one can be a NotModified.
 */
export interface ClientPages<
  Client,
  Request,
  Response,
  Item,
  Next,
  Got extends Result<Response> | NotModified = Result<Response>,
> extends Pages<Request, Response, Item, Next> {
  /**
   * Gets one page with `client`: the first for `request`, or the one
   * `next` names. It is `resume`, the call, then `page`. A query of the
   * page replaces that of `options`. It reads one page, and neither
   * loops nor checks a `next` that a caller gave back.
   *
   * @param client The client of reads.
   * @param request The first request of the listing.
   * @param next What a page before gave as its `next`. Without it, the first page.
   * @param options The options of the call.
   * @returns The page with its result, or a NotModified from a conditional operation.
   * @throws What the call of the client throws.
   */
  fetch(
    client: Client,
    request: Request,
    next?: Next,
    options?: RequestOptions,
  ): Promise<Got extends NotModified ? NotModified : FetchedPage<Response, Item, Next>>;
}

/**
 * Returns `pages` with a `fetch` that calls its operation through `call`.
 *
 * @param pages The pager of the operation.
 * @param call Calls the operation on a client, with a request and options.
 * @returns The pager, with `fetch`.
 */
export function withClient<Client, Request, Response, Item, Next, Got extends Result<Response> | NotModified>(
  pages: Pages<Request, Response, Item, Next>,
  call: (client: Client, request: Request, options: RequestOptions) => Promise<Got>,
): ClientPages<Client, Request, Response, Item, Next, Got> {
  type Fetched = Got extends NotModified ? NotModified : FetchedPage<Response, Item, Next>;
  return {
    page: (result, request) => pages.page(result, request),
    resume: (request, next) => pages.resume(request, next),
    async fetch(client, request, next, options) {
      const resumed = pages.resume(request, next);
      const result: Result<Response> | NotModified = await call(client, resumed.request, {
        ...options,
        ...resumed.options,
      });
      if (result.notModified === true) {
        return result as Fetched;
      }
      return { ...pages.page(result, resumed.request), result } as Fetched;
    },
  };
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
 * `omit` is the query parameters that are never part of what names the
 * next page: the credential, for an API that takes it in the query and
 * writes it back in the link.
 *
 * @param spec Where the items are, what says that there is another page, and the query parameters to leave out.
 * @returns The pager of the operation.
 */
export function linkPages<Request, Response, P extends string = ''>(spec: {
  items?: P;
  more?: string;
  omit?: readonly string[];
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
      const next = [...new URLSearchParams(query)].filter(([name]) => spec.omit?.includes(name) !== true);
      // A link with no query names the same page again.
      return { items, next: next.length === 0 ? undefined : next };
    },
    resume(request, next) {
      // Each parameter of the link replaces that of the request with its name.
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
 * page is the last. Without either, only a page with no items is the
 * last: a page shorter than the limit is not, since an API can give fewer
 * items than a request asks for.
 *
 * @param spec Where the items are, the fields of the request, and what says that there is another page.
 * @returns The pager of the operation.
 */
export function offsetPages<Request, Response, P extends string = ''>(spec: {
  items?: P;
  offset: string;
  more?: string;
  last?: string;
}): Pages<Request, Response, ItemOf<Response, P>, number> {
  return {
    page(result, request) {
      const items = itemsOf<ItemOf<Response, P>>(result.data, spec.items);
      if (items.length === 0 || ended(result.data, spec)) {
        return { items, next: undefined };
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
 *
 * @param spec Where the items and the next cursor are, the field of the request, and what says that there is another page.
 * @returns The pager of the operation.
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
