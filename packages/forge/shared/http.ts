/**
 * Shared HTTP Utilities
 *
 * Provides consistent HTTP method mapping used across all transformers.
 */

/**
 * HTTP methods supported by the API
 */
export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Map a schema method name to an HTTP method.
 *
 * Conventions:
 * - list, info, get, export → GET
 * - create → POST
 * - update → PUT or PATCH
 * - delete → DELETE
 * - Everything else (execute, restore, apply, etc.) → POST
 *
 * @example
 * getHttpMethod('list') // 'GET'
 * getHttpMethod('create') // 'POST'
 * getHttpMethod('delete') // 'DELETE'
 * getHttpMethod('execute') // 'POST'
 */
export function getHttpMethod(methodName: string): HttpMethod {
  switch (methodName) {
    // Read operations
    case 'list':
    case 'info':
    case 'get':
    case 'export':
    case 'status':
    case 'insights':
    case 'report':
    case 'bytime':
      return 'GET';

    // Write operations
    case 'create':
      return 'POST';

    // Update operations
    case 'update':
    case 'edit':
      return 'PUT';

    case 'patch':
      return 'PATCH';

    // Delete operations
    case 'delete':
    case 'remove':
      return 'DELETE';

    // Action operations (default to POST)
    default:
      return 'POST';
  }
}

/**
 * Check if an HTTP method is safe (doesn't modify resources).
 * Safe methods can be cached and retried safely.
 *
 * @see https://www.rfc-editor.org/rfc/rfc9110#section-9.2.1
 */
export function isSafeMethod(method: HttpMethod): boolean {
  return method === 'GET' || method === 'HEAD';
}

/**
 * Check if an HTTP method is idempotent.
 * Idempotent methods produce the same result when called multiple times.
 *
 * @see https://www.rfc-editor.org/rfc/rfc9110#section-9.2.2
 */
export function isIdempotentMethod(method: HttpMethod): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'PUT' || method === 'DELETE';
}

/**
 * Check if an HTTP method typically has a request body.
 */
export function methodHasBody(method: HttpMethod): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH';
}
