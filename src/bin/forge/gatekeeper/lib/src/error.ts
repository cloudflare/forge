import { isRecord } from './codec.js';

/**
 * A response whose status is not 2XX, as the transport gives it to what
 * builds the error to throw.
 */
export interface Failure {
  /**
   * The `operationId` of the operation.
   */
  operationId: string;
  /**
   * The status of the response.
   */
  status: number;
  /**
   * The headers of the response.
   */
  headers: Headers;
  /**
   * The message of a JSON error body, as the API wrote it and of any
   * length, or undefined when the body has none.
   */
  message: string | undefined;
  /**
   * The body decoded as the error the API declares for the status, or the
   * body as text when it declares none or the body does not parse, or
   * undefined when the body is empty.
   */
  details: unknown;
}

// The longest message of an ApiError that comes from a response.
const MESSAGE_LIMIT = 200;

/**
 * An error response from the API. It is what a client throws unless its
 * options have an `error` of their own.
 */
export class ApiError extends Error {
  /**
   * The `operationId` of the operation.
   */
  readonly operationId: string;
  /**
   * The status of the response.
   */
  readonly status: number;
  /**
   * The headers of the response.
   */
  readonly headers: Headers;
  /**
   * The body decoded as the error the API declares for the status, or the
   * body as text when it declares none or the body does not parse, or
   * undefined when the body is empty. It is what the API sent, so it is
   * not for a message or a log that an agent reads.
   */
  readonly details: unknown;

  /**
   * The message is the status, then the start of the message of the API.
   */
  constructor(failure: Failure) {
    let message = `${failure.operationId}: status ${failure.status}`;
    if (failure.message !== undefined) {
      const said = failure.message;
      message += `: ${said.length > MESSAGE_LIMIT ? `${said.slice(0, MESSAGE_LIMIT)}…` : said}`;
    }
    super(message);
    this.name = 'ApiError';
    this.operationId = failure.operationId;
    this.status = failure.status;
    this.headers = failure.headers;
    this.details = failure.details;
  }
}

/**
 * A success response whose body is not what the operation declares: it is
 * not JSON, or it does not decode. It has no status, so that nothing reads
 * it as an error response of the API, and it does not have the body.
 */
export class DecodeError extends Error {
  /**
   * The `operationId` of the operation.
   */
  readonly operationId: string;

  constructor(operationId: string, options?: ErrorOptions) {
    super(`${operationId}: the response body is not what the operation declares`, options);
    this.name = 'DecodeError';
    this.operationId = operationId;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Returns the message of a JSON error body: a string `message`, `error`,
 * `detail` or `title`, then `error.message` or `error.detail`, then the
 * messages of an `errors` array.
 */
export function errorMessage(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const message = text(body['message']) ?? text(body['error']) ?? text(body['detail']) ?? text(body['title']);
  if (message !== undefined) {
    return message;
  }
  const error = body['error'];
  if (isRecord(error)) {
    const nested = text(error['message']) ?? text(error['detail']);
    if (nested !== undefined) {
      return nested;
    }
  }
  const errors = body['errors'];
  if (Array.isArray(errors)) {
    const messages: string[] = [];
    for (const item of errors) {
      const m = isRecord(item) ? text(item['message']) : text(item);
      if (m !== undefined) {
        messages.push(m);
      }
    }
    if (messages.length > 0) {
      return messages.join('; ');
    }
  }
  return undefined;
}
