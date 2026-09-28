/**
 * Cloudflare API success bodies use a standard envelope:
 * `{ success, errors, messages, result, result_info? }`.
 *
 * Fern transform fix-26 rewrites success *types* to:
 * - bare `result` for non-list payloads
 * - `{ result, result_info }` for list/page payloads (array `result`)
 *
 * The wire body is still the full envelope. This Fern custom runtime (installed
 * via install-fern-custom-runtime / `.fernignore`) unwraps it.
 *
 * Page preservation (keep `{ result, result_info }` even when `result_info` is
 * omitted on the wire) is inferred when `result` is an array — matching fix-26's
 * page-shape rule — so callers do not need a postgen `responseType: "cloudflare-page"`
 * mark. Explicit `responseType === "cloudflare-page"` remains supported.
 */
export function unwrapCloudflareEnvelope(body: unknown, responseType?: string): unknown {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }
  if (!('success' in body) || !('result' in body)) {
    return body;
  }
  const get = (key: string): unknown => Reflect.get(body, key);
  if (get('success') === false) {
    const rawErrors = get('errors');
    const errors = Array.isArray(rawErrors) ? rawErrors : [];
    const message =
      errors
        .map((entry) => {
          if (typeof entry === 'string') return entry;
          if (entry && typeof entry === 'object' && 'message' in entry) {
            const message: unknown = Reflect.get(entry, 'message');
            return typeof message === 'string' ? message : undefined;
          }
          return undefined;
        })
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .join(', ') || 'Cloudflare API request failed';
    const error = new Error(message);
    error.name = 'CloudflareApiEnvelopeError';
    Object.assign(error, { body });
    throw error;
  }

  const result = get('result');
  const preservePage = responseType === 'cloudflare-page' || Array.isArray(result);

  if (preservePage) {
    return {
      result,
      result_info: get('result_info'),
    };
  }
  return result;
}
