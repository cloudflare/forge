import { type Codec, isRecord, parse, set, toBase64 } from './codec.js';
import { ApiError, errorMessage } from './error.js';

/**
 * What a gatekeeper gives the generated clients to send their requests
 * with.
 */
export interface Provider {
  /**
   * Sends a request to the API and returns its response, whatever its
   * status. The provider adds what the request does not have: the URL the
   * path is relative to, the credentials, and what else the API asks of
   * every request, such as a timeout or a limit on the size of the body.
   */
  send(request: ProviderRequest): Promise<Response>;
}

/**
 * A request of a generated client, for a provider to send.
 */
export interface ProviderRequest {
  /**
   * The HTTP method.
   */
  method: string;
  /**
   * The path of the operation, with each path parameter as `{field}`.
   */
  route: string;
  /**
   * The values of the path parameters, by field, as they are before they
   * are encoded.
   */
  params: { readonly [field: string]: string };
  /**
   * The path of the URL: the route with each path parameter encoded, then
   * the query. It is relative to the URL of the API.
   */
  path: string;
  /**
   * The headers of the request, without credentials.
   */
  headers: Headers;
  /**
   * The body, as JSON text.
   */
  body?: string;
  /**
   * Aborts the request.
   */
  signal?: AbortSignal;
}

/**
 * The options every client takes.
 */
export interface BaseClientOptions {
  /**
   * What sends the requests.
   */
  provider: Provider;
  /**
   * Headers sent with every request.
   */
  headers?: HeadersInit;
}

/**
 * The options of a call. Every member is optional.
 */
export interface RequestOptions {
  /**
   * Aborts the request.
   */
  signal?: AbortSignal;
  /**
   * Headers sent with the request, which replace those of the client.
   */
  headers?: HeadersInit;
  /**
   * Query parameters appended after those of the request.
   */
  query?: URLSearchParams;
}

/**
 * A success response.
 */
export interface Result<T> {
  /**
   * The decoded body, or undefined when the response has none.
   */
  data: T;
  /**
   * The status of the response.
   */
  status: number;
  /**
   * The headers of the response.
   */
  headers: Headers;
}

/**
 * An operation of the API, as the generated clients describe it.
 */
export interface Operation {
  /**
   * The HTTP method.
   */
  method: string;
  /**
   * The path of the URL, with each path parameter as `{field}`.
   */
  route: string;
  /**
   * The wire names of the query parameters, by field.
   */
  query?: { readonly [field: string]: string };
  /**
   * The query parameters whose arrays are joined with commas.
   */
  joined?: readonly string[];
  /**
   * Where the body is: the fields of the request that are not parameters
   * ("flat"), or its `body` field ("nested"). No body when absent.
   */
  body?: 'flat' | 'nested';
  /**
   * The media type of the body, when not application/json.
   */
  contentType?: string;
  /**
   * The codec of the body, when it has something to convert.
   */
  request?: Codec;
  /**
   * The codec of the response body, null when it has nothing to convert,
   * and absent when the operation has no response body.
   */
  response?: Codec | null;
  /**
   * The declared error responses, by status, range such as "4XX", or
   * "default": the codec of the body, true for a JSON body with nothing to
   * convert, and false for a body that is not JSON.
   */
  errors?: { readonly [status: string]: Codec | boolean };
}

type Fields = { [key: string]: unknown };

// The fields of each operation that are parameters rather than body.
const paramFields = new WeakMap<Operation, Set<string>>();

function paramsOf(operation: Operation): Set<string> {
  let fields = paramFields.get(operation);
  if (fields === undefined) {
    fields = new Set(Object.keys(operation.query ?? {}));
    for (const [, field] of operation.route.matchAll(/\{([^}]+)\}/g)) {
      fields.add(field!);
    }
    paramFields.set(operation, fields);
  }
  return fields;
}

function toParam(value: unknown): string {
  if (value instanceof Uint8Array) {
    return toBase64(value);
  }
  if (isRecord(value)) {
    return JSON.stringify(value);
  }
  return String(value);
}

function lookup(errors: Operation['errors'], status: number): Codec | boolean | undefined {
  if (errors === undefined) {
    return undefined;
  }
  for (const key of [String(status), `${Math.floor(status / 100)}XX`]) {
    if (Object.hasOwn(errors, key)) {
      return errors[key];
    }
  }
  return Object.hasOwn(errors, 'default') ? errors['default'] : undefined;
}

async function apiError(operation: Operation, response: Response): Promise<ApiError> {
  const text = await response.text();
  let body: unknown;
  let json = false;
  if (text !== '') {
    try {
      body = parse(text);
      json = true;
    } catch {
      // The body is kept as text.
    }
  }
  const declared = lookup(operation.errors, response.status);
  let details: unknown = text === '' ? undefined : text;
  if (json && declared !== undefined && declared !== false) {
    details = declared === true ? body : declared.decode(body);
  }
  const message = (json ? errorMessage(body) : undefined) ?? `${response.status} ${response.statusText}`.trim();
  return new ApiError(message, response, details);
}

/**
 * Sends the requests of the generated clients through a provider.
 */
export class Transport {
  readonly #options: BaseClientOptions;

  /**
   * Checks the options of a client.
   */
  constructor(options: BaseClientOptions) {
    if (typeof options?.provider?.send !== 'function') {
      throw new TypeError('createClient: provider is required');
    }
    this.#options = options;
  }

  /**
   * Sends a request for operation and returns its response, with the body
   * decoded. A response whose status is not 2XX is thrown as an ApiError,
   * and so is a 304: it has the status and the response.
   */
  async send<T>(
    operation: Operation,
    request: object | undefined,
    options: RequestOptions | undefined,
  ): Promise<Result<T>> {
    const fields = (request ?? {}) as Fields;
    const headers = new Headers({ accept: 'application/json' });
    const sent: ProviderRequest = { method: operation.method, route: operation.route, params: {}, path: '', headers };
    sent.path = this.#path(operation, fields, options, sent.params as { [field: string]: string });
    const body = this.#body(operation, fields);
    if (body !== undefined) {
      headers.set('content-type', operation.contentType ?? 'application/json');
      sent.body = JSON.stringify(body);
    }
    new Headers(this.#options.headers).forEach((value, key) => {
      headers.set(key, value);
    });
    new Headers(options?.headers).forEach((value, key) => {
      headers.set(key, value);
    });
    if (options?.signal !== undefined) {
      sent.signal = options.signal;
    }
    const response = await this.#options.provider.send(sent);
    if (response.status < 200 || response.status > 299) {
      throw await apiError(operation, response);
    }
    const result = { data: undefined as T, status: response.status, headers: response.headers };
    if (operation.response === undefined) {
      return result;
    }
    const text = await response.text();
    if (text === '') {
      return result;
    }
    let value: unknown;
    try {
      value = parse(text);
    } catch (e) {
      throw new ApiError('the response body is not valid JSON', response, text, {
        cause: e,
      });
    }
    result.data = (operation.response === null ? value : operation.response.decode(value)) as T;
    return result;
  }

  // Returns the path and query of a request, and sets in `params` the value
  // of each path parameter.
  #path(
    operation: Operation,
    request: Fields,
    options: RequestOptions | undefined,
    params: { [field: string]: string },
  ): string {
    const path = operation.route.replace(/\{([^}]+)\}/g, (_, field: string) => {
      const value = request[field];
      if (value === undefined || value === null || value === '') {
        throw new TypeError(`${field} is required`);
      }
      const param = toParam(value);
      params[field] = param;
      return encodeURIComponent(param);
    });
    const query = new URLSearchParams();
    for (const [field, wire] of Object.entries(operation.query ?? {})) {
      const value = request[field];
      if (value === undefined || value === null) {
        continue;
      }
      if (!Array.isArray(value)) {
        query.append(wire, toParam(value));
      } else if (operation.joined?.includes(field)) {
        query.append(wire, value.map(toParam).join(','));
      } else {
        for (const item of value) {
          query.append(wire, toParam(item));
        }
      }
    }
    options?.query?.forEach((value, key) => {
      query.append(key, value);
    });
    const search = query.toString();
    return search === '' ? path : `${path}?${search}`;
  }

  #body(operation: Operation, request: Fields): unknown {
    let body: unknown;
    if (operation.body === 'nested') {
      body = request['body'];
    } else if (operation.body === 'flat') {
      const params = paramsOf(operation);
      const fields: Fields = {};
      for (const key of Object.keys(request)) {
        if (!params.has(key)) {
          set(fields, key, request[key]);
        }
      }
      body = fields;
    }
    if (body === undefined || operation.request === undefined) {
      return body;
    }
    return operation.request.encode(body);
  }
}
