import type { Failure } from './error.js';
import type { Provider, ProviderRequest } from './transport.js';

/**
 * The options of a provider that sends requests with `fetch`.
 */
export interface FetchProviderOptions {
  /**
   * The URL the paths of the API are relative to. It is `https`, but for
   * a host of the machine itself.
   */
  baseUrl: string;
  /**
   * Adds the credential to a request, as a header or a query parameter.
   * It is called for each request, after the headers of the client are
   * set, so nothing a caller sends can replace what it sets.
   *
   * @param request The headers and the query of the request, to add to.
   */
  authorize(request: { headers: Headers; query: URLSearchParams }): void;
  /**
   * Whether the provider sends an operation that writes. Without it, one
   * is refused before it is sent, and so is a method other than `GET`,
   * `HEAD` or `POST`: the kind of an operation is what the config says,
   * so the method is checked too. Give a provider that writes only to
   * the client of writes.
   */
  writes?: boolean;
  /**
   * The `accept` header, which is `application/json` without it. An API
   * that versions by media type takes its version here. A header of a
   * call replaces it.
   */
  accept?: string;
  /**
   * How long a request can take, in milliseconds. It is 30 seconds
   * without it.
   */
  timeoutMs?: number;
  /**
   * The largest body that is read, in bytes. It is 4 MiB without it. A
   * larger one is thrown as a ResponseTooLargeError.
   */
  maxResponseBytes?: number;
  /**
   * What sends a request, in place of the global `fetch`.
   */
  fetch?: typeof fetch;
}

/**
 * A response whose body is larger than the provider reads. It has no
 * status, so nothing reads it as an answer of the API.
 */
export class ResponseTooLargeError extends Error {
  /**
   * The `operationId` of the operation.
   */
  readonly operationId: string;

  /**
   * @param operationId The `operationId` of the operation.
   */
  constructor(operationId: string) {
    super(`${operationId}: the response is larger than the provider reads`);
    this.name = 'ResponseTooLargeError';
    this.operationId = operationId;
  }
}

/**
 * A request that got no response: the network failed, or the request
 * took too long. It has no status. Whether a write was made is not known.
 */
export class UnreachableError extends Error {
  /**
   * The `operationId` of the operation.
   */
  readonly operationId: string;

  /**
   * @param operationId The `operationId` of the operation.
   * @param cause What `fetch` threw.
   */
  constructor(operationId: string, cause: unknown) {
    super(`${operationId}: the API could not be reached`, { cause });
    this.name = 'UnreachableError';
    this.operationId = operationId;
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Returns a provider that sends each request with `fetch`. It does not
 * follow a redirect, which would carry the credential to another URL:
 * the redirect is returned, with no body, and the client throws it. It
 * reads no more of a body than its limit.
 *
 * Make one for each use of a credential, and do not keep it.
 *
 * @param options Where the API is, how a request is authorized, and the limits.
 * @returns The provider.
 * @throws TypeError when the base URL is not `https`, or has a query, a fragment or a credential.
 */
export function fetchProvider(options: FetchProviderOptions): Provider {
  const base = new URL(options.baseUrl);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && LOCAL_HOSTS.has(base.hostname))) {
    throw new TypeError('fetchProvider: baseUrl is not https');
  }
  if (base.search !== '' || base.hash !== '' || base.username !== '' || base.password !== '') {
    throw new TypeError('fetchProvider: baseUrl has a query, a fragment or a credential');
  }
  const prefix = base.pathname.replace(/\/+$/, '');
  const limit = options.maxResponseBytes ?? 4 * 1024 * 1024;
  const send = options.fetch ?? fetch;

  return {
    async send(request: ProviderRequest) {
      if (options.writes !== true && (request.kind !== 'read' || !['GET', 'HEAD', 'POST'].includes(request.method))) {
        throw new TypeError(`${request.operationId}: a provider of reads cannot send a write`);
      }
      const headers = new Headers(request.headers);
      if (!headers.has('accept')) {
        headers.set('accept', options.accept ?? 'application/json');
      }
      const query = new URLSearchParams(request.query);
      options.authorize({ headers, query });
      const url = new URL(base);
      url.pathname = prefix + request.path;
      url.search = query.toString();

      const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
      const init: RequestInit = {
        method: request.method,
        headers,
        redirect: 'manual',
        signal: request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]),
      };
      if (request.body !== undefined) {
        init.body = request.body;
      }
      let response: Response;
      try {
        response = await send(url, init);
      } catch (error) {
        throw new UnreachableError(request.operationId, error);
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return { status: response.status, headers: response.headers, text: '' };
      }
      let text: string;
      try {
        text = await readCapped(response, limit);
      } catch (error) {
        if (error === TOO_LARGE) {
          throw new ResponseTooLargeError(request.operationId);
        }
        throw new UnreachableError(request.operationId, error);
      }
      return { status: response.status, headers: response.headers, text };
    },
  };
}

/**
 * A variable of a server URL: its default, and its values when the
 * document lists them.
 */
export interface ServerVariable {
  default?: string;
  values?: readonly string[];
}

/**
 * Returns the URL of a server from its template, such as
 * `https://{region}.example.com`, with each variable as `given` has it,
 * or as its default. A value is one the document lists. Where it lists
 * none, it is letters, digits, `.`, `_` and `-`, so that a value cannot
 * name another host or path.
 *
 * @param template The URL of the server, with its variables in braces.
 * @param variables What the document says of each variable.
 * @param given The values to use.
 * @returns The URL.
 * @throws TypeError when a variable has no value, or one the server does not take.
 */
export function serverUrl(
  template: string,
  variables: { readonly [name: string]: ServerVariable },
  given: { readonly [name: string]: string | undefined } = {},
): string {
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const variable = Object.hasOwn(variables, name) ? variables[name] : undefined;
    const value = (Object.hasOwn(given, name) ? given[name] : undefined) ?? variable?.default;
    if (value === undefined) {
      throw new TypeError(`serverUrl: ${name} is required`);
    }
    const allowed = variable?.values;
    if (
      allowed === undefined
        ? !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.includes('..')
        : !allowed.includes(value)
    ) {
      throw new TypeError(`serverUrl: ${name} is not a value the server takes`);
    }
    return value;
  });
}

const TOO_LARGE = Symbol('too large');

// Returns the body of a response as text, or throws TOO_LARGE when it has
// more than `limit` bytes.
async function readCapped(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > limit) {
    await response.body?.cancel();
    throw TOO_LARGE;
  }
  if (response.body === null) {
    return '';
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return text + decoder.decode();
    }
    read += value.byteLength;
    if (read > limit) {
      await reader.cancel();
      throw TOO_LARGE;
    }
    text += decoder.decode(value, { stream: true });
  }
}

/**
 * What a failure means, as far as its status says.
 */
export type Reason =
  /** The credential was rejected: 401. */
  | 'credential'
  /** The request was refused for this caller: 403. */
  | 'denied'
  /** Nothing is there: 404 and 410. An API can answer this to hide a denial. */
  | 'missing'
  /** Too many requests: 429. */
  | 'rate-limit'
  /** The request itself is wrong: 400 and 422. */
  | 'invalid'
  /** The state of the resource does not allow it: 409 and 412. */
  | 'conflict'
  /** The API failed: 5XX. Whether a write was made is not known. */
  | 'unavailable'
  /** Anything else, with a redirect that was not followed. */
  | 'other';

const REASONS: { readonly [status: number]: Reason } = {
  400: 'invalid',
  401: 'credential',
  403: 'denied',
  404: 'missing',
  409: 'conflict',
  410: 'missing',
  412: 'conflict',
  422: 'invalid',
  429: 'rate-limit',
};

/**
 * Returns what a failure means, from its status. `rules` has what the
 * provider documents otherwise, by status, such as `{ 403: 'rate-limit' }`
 * for an API that limits with a 403: check its headers in a function of
 * your own where the status alone does not say.
 *
 * It is a default, not a fact about the provider. A failure that the body
 * says, with a 2XX, is `other` unless a rule names its status.
 *
 * @param failure The failure, or its status.
 * @param rules The reason of a status, where the provider documents another than the default.
 * @returns The reason.
 */
export function reasonOf(failure: Pick<Failure, 'status'>, rules?: { readonly [status: number]: Reason }): Reason {
  const { status } = failure;
  if (rules !== undefined && Object.hasOwn(rules, status)) {
    return rules[status] ?? 'other';
  }
  if (Object.hasOwn(REASONS, status)) {
    return REASONS[status] ?? 'other';
  }
  return status >= 500 && status <= 599 ? 'unavailable' : 'other';
}

/**
 * Returns how long the `retry-after` header of a response says to wait,
 * in seconds, or undefined when it has none that can be read. The header
 * is seconds or a date.
 *
 * @param headers The headers of the response.
 * @param now The time to count from, in milliseconds, which is the current time without it.
 * @returns The seconds to wait, or undefined.
 */
export function retryAfterSeconds(headers: Headers, now: number = Date.now()): number | undefined {
  const value = headers.get('retry-after')?.trim();
  if (value === undefined || value === '') {
    return undefined;
  }
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - now) / 1000));
}

/**
 * Returns a message for a reason that has nothing the provider sent, for
 * an error that an agent reads. `name` is the name of the provider.
 *
 * @param reason The reason.
 * @param name The name of the provider, as a person knows it.
 * @returns The message.
 */
export function reasonMessage(reason: Reason, name: string): string {
  switch (reason) {
    case 'credential':
      return `${name} rejected the connection's credential.`;
    case 'denied':
      return `${name} denied access to that.`;
    case 'missing':
      return `${name} has nothing there, or does not show it to this connection.`;
    case 'rate-limit':
      return `${name} is limiting this connection. Try again later.`;
    case 'invalid':
      return `${name} refused the request as invalid.`;
    case 'conflict':
      return `${name} refused the request: the state of what it changes does not allow it.`;
    case 'unavailable':
      return `${name} failed to answer. A change may or may not have been made.`;
    default:
      return `${name} could not answer the request.`;
  }
}
