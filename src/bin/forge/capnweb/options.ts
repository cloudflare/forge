//@ts-expect-error // Generated code will resolve #sdk, this is just avoid the import error here.
import type { RequestOptions } from '#sdk';

/**
 * The options of a call to a method of an Api.
 */
export interface Options {
  /**
   * Headers sent with the request, which replace those of the same name set on the client.
   */
  headers?: Headers | Record<string, string> | [string, string][];
  /**
   * Query parameters appended after those of the client. A list of pairs repeats a key in order. Cap'n Web doesn't
   * carry a URLSearchParams, so the server makes one for the SDK.
   */
  query?: Record<string, string> | [string, string][];
}

/**
 * Returns options as the options of a method of the SDK.
 */
export function requestOptions(options: Options | undefined): RequestOptions | undefined {
  if (options === undefined || options === null) {
    return undefined;
  }
  const out: RequestOptions = {};
  if (options.headers !== undefined) {
    out.headers = options.headers;
  }
  if (options.query !== undefined) {
    out.query = new URLSearchParams(options.query);
  }
  return out;
}
