import { isRecord } from './codec.js';

/**
 * A response that is a failure, as the transport gives it to what builds
 * the error to throw: one whose status is not 2XX, or one whose body says
 * so, for an API that answers a failure with a 2XX.
 */
export interface Failure {
  /**
   * The `operationId` of the operation.
   */
  operationId: string;
  /**
   * The status of the response. It is a 2XX when the body is what says
   * that the response is a failure.
   */
  status: number;
  /**
   * What says that the response is a failure: its status, or its body.
   */
  source: 'status' | 'body';
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
   * The body as it parsed, when it is JSON, or as text when it is not, or
   * undefined when it is empty.
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
   * The status of the response, which is a 2XX when the source is the
   * body.
   */
  readonly status: number;
  /**
   * What says that the response is a failure: its status, or its body.
   */
  readonly source: 'status' | 'body';
  /**
   * The headers of the response.
   */
  readonly headers: Headers;
  /**
   * The body as it parsed, when it is JSON, or as text when it is not, or
   * undefined when it is empty. It is what the API sent, so it is not for
   * a message or a log that an agent reads.
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
    this.source = failure.source;
    this.headers = failure.headers;
    this.details = failure.details;
  }
}

/**
 * A success response whose body cannot be read as the operation declares:
 * it is not JSON, its codec throws, or it is empty where the operation has
 * a body. A body of JSON with other fields or types than the operation
 * declares is not checked, and is returned as it is. The error has no
 * status, so that nothing reads it as an error response of the API, and
 * neither the body nor the error of the parser, which quotes it.
 */
export class DecodeError extends Error {
  /**
   * The `operationId` of the operation.
   */
  readonly operationId: string;

  constructor(operationId: string) {
    super(`${operationId}: the response body is not what the operation declares`);
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
