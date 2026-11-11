import { type Codec, isRecord, parse, set, toBase64 } from './codec.js';
import { ApiError, DecodeError, errorMessage, type Failure } from './error.js';

/**
 * What a gatekeeper gives the generated clients to send their requests
 * with.
 */
export interface Provider {
  /**
   * Sends a request to the API and returns its response, whatever its
   * status. The provider adds what the request does not have: the URL the
   * path is relative to, the credentials, and what else the API asks of
   * every request, such as a timeout. It reads the body, so it is what
   * limits its size.
   */
  send(request: ProviderRequest): Promise<ProviderResponse>;
}

/**
 * A response of the API, with its body read.
 */
export interface ProviderResponse {
  /**
   * The status.
   */
  status: number;
  /**
   * The headers.
   */
  headers: Headers;
  /**
   * The body as text, which is empty when the response has none.
   */
  text: string;
}

/**
 * A request of a generated client, for a provider to send.
 */
export interface ProviderRequest {
  /**
   * The `operationId` of the operation.
   */
  operationId: string;
  /**
   * Whether the operation reads or writes.
   */
  kind: 'read' | 'write';
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
   * The path of the URL, without the query: the route with each path
   * parameter encoded. It is relative to the URL of the API.
   */
  path: string;
  /**
   * The query parameters, which are empty when the request has none.
   */
  query: URLSearchParams;
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
  /**
   * Returns the error to throw for a response whose status is not 2XX.
   * Without it, or when it does not return an Error, the error is an
   * ApiError.
   */
  error?: (failure: Failure) => Error;
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
   * Query parameters. One replaces the parameter of the request that has
   * its name.
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
  /**
   * Never set. It tells a success response from a NotModified.
   */
  notModified?: undefined;
}

/**
 * A 304 response to a conditional operation: what the request named with
 * `If-None-Match` or `If-Modified-Since` has not changed.
 */
export interface NotModified {
  /**
   * Always true.
   */
  notModified: true;
  /**
   * The status of the response.
   */
  status: 304;
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
   * The `operationId`.
   */
  id: string;
  /**
   * Whether the operation reads or writes.
   */
  kind: 'read' | 'write';
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

function failure(operation: Operation, response: ProviderResponse): Failure {
  const { text } = response;
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
    details = body;
    if (declared !== true) {
      try {
        details = declared.decode(body);
      } catch {
        // The body is kept as it parsed.
      }
    }
  }
  return {
    operationId: operation.id,
    status: response.status,
    headers: response.headers,
    message: json ? errorMessage(body) : undefined,
    details,
  };
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
   * decoded. A response whose status is not 2XX is thrown, as an ApiError
   * unless the options of the client say otherwise. A 2XX response whose
   * body cannot be read as the operation declares is thrown as a
   * DecodeError. A path parameter that is `.` or `..` is refused.
   */
  async send<T>(
    operation: Operation,
    request: object | undefined,
    options: RequestOptions | undefined,
  ): Promise<Result<T>> {
    return this.#result(operation, await this.#exchange(operation, request, options));
  }

  /**
   * Sends a request as send does, for an operation that the config says
   * is conditional: a 304 response is returned as a NotModified, and not
   * thrown.
   */
  async sendConditional<T>(
    operation: Operation,
    request: object | undefined,
    options: RequestOptions | undefined,
  ): Promise<Result<T> | NotModified> {
    const response = await this.#exchange(operation, request, options);
    if (response.status === 304) {
      return { notModified: true, status: 304, headers: response.headers };
    }
    return this.#result(operation, response);
  }

  async #exchange(
    operation: Operation,
    request: object | undefined,
    options: RequestOptions | undefined,
  ): Promise<ProviderResponse> {
    const fields = (request ?? {}) as Fields;
    const headers = new Headers({ accept: 'application/json' });
    const params: { [field: string]: string } = {};
    const sent: ProviderRequest = {
      operationId: operation.id,
      kind: operation.kind,
      method: operation.method,
      route: operation.route,
      params,
      path: this.#path(operation, fields, params),
      query: this.#query(operation, fields, options),
      headers,
    };
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
    return this.#options.provider.send(sent);
  }

  #result<T>(operation: Operation, response: ProviderResponse): Result<T> {
    const { status } = response;
    // A status that is not a number is not a success.
    if (typeof status !== 'number' || !(status >= 200 && status <= 299)) {
      const failed = failure(operation, response);
      const error = this.#options.error?.(failed);
      throw error instanceof Error ? error : new ApiError(failed);
    }
    const result: Result<T> = { data: undefined as T, status, headers: response.headers };
    if (operation.response === undefined) {
      return result;
    }
    if (response.text === '') {
      // Only a response that says it has no content, or one to a HEAD, may
      // be empty where the operation declares a body.
      if (status === 204 || status === 205 || operation.method === 'HEAD') {
        return result;
      }
      throw new DecodeError(operation.id);
    }
    try {
      const value = parse(response.text);
      result.data = (operation.response === null ? value : operation.response.decode(value)) as T;
    } catch {
      throw new DecodeError(operation.id);
    }
    return result;
  }

  // Returns the path of a request, and sets in `params` the value of each
  // path parameter.
  #path(operation: Operation, request: Fields, params: { [field: string]: string }): string {
    return operation.route.replace(/\{([^}]+)\}/g, (_, field: string) => {
      const value = request[field];
      if (value === undefined || value === null || value === '') {
        throw new TypeError(`${field} is required`);
      }
      const param = toParam(value);
      // A dot segment is not encoded, and what resolves the URL removes it
      // with the segment before it, which makes the path another route's.
      if (param === '.' || param === '..') {
        throw new TypeError(`${field} cannot be "${param}"`);
      }
      params[field] = param;
      return encodeURIComponent(param);
    });
  }

  // Returns the query of a request: its query parameters, then those of the
  // options, each in place of the parameters that have its name.
  #query(operation: Operation, request: Fields, options: RequestOptions | undefined): URLSearchParams {
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
    const extra = options?.query;
    for (const key of new Set(extra?.keys())) {
      query.delete(key);
      for (const value of extra!.getAll(key)) {
        query.append(key, value);
      }
    }
    return query;
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
