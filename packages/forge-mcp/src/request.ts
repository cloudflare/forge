import type { CatalogueTool, ParamRoute } from './catalogue.ts';

/** Arguments a tool can't be called with, such as a missing required one. */
export class InvalidArguments extends Error {}

/**
 * The HTTP request a tool call makes: path parameters substituted and
 * encoded, query parameters serialized as OpenAPI's `form` style, headers
 * set, and the JSON body sent as given. Values are not validated here; the
 * API validates them.
 */
export function buildRequest(tool: CatalogueTool, args: Record<string, unknown>, baseUrl: string): Request {
  const required = tool.inputSchema.required;
  if (Array.isArray(required)) {
    const missing = required.filter((key) => args[key] === undefined);
    if (missing.length > 0) {
      throw new InvalidArguments(`Missing required arguments: ${missing.join(', ')}`);
    }
  }

  const { method, path, params, body } = tool.request;
  let resolved = path;
  const query = new URLSearchParams();
  const headers = new Headers({ Accept: 'application/json' });

  for (const param of params) {
    const value = args[param.key];
    if (value === undefined || value === null) {
      continue;
    }
    switch (param.in) {
      case 'path':
        resolved = resolved.replaceAll(`{${param.name}}`, encodeURIComponent(scalar(param, value)));
        break;
      case 'query':
        appendQuery(query, param, value);
        break;
      case 'header':
        headers.set(
          param.name,
          Array.isArray(value) ? value.map((item) => scalar(param, item)).join(',') : scalar(param, value),
        );
        break;
    }
  }

  const unfilled = resolved.match(/\{([^}]+)\}/);
  if (unfilled) {
    throw new InvalidArguments(`Missing path parameter: ${unfilled[1]}`);
  }

  const url = new URL(baseUrl.replace(/\/+$/, '') + resolved);
  for (const [name, value] of query) {
    url.searchParams.append(name, value);
  }

  const init: RequestInit = { method, headers };
  if (body && args[body.key] !== undefined) {
    headers.set('Content-Type', body.mediaType);
    init.body = JSON.stringify(args[body.key]);
  }
  return new Request(url, init);
}

/** OpenAPI's default query style, `form`: `a=1&a=2` exploded, `a=1,2` not. */
function appendQuery(query: URLSearchParams, param: ParamRoute, value: unknown): void {
  const explode = param.explode ?? true;
  if (Array.isArray(value)) {
    const items = value.map((item) => scalar(param, item));
    if (explode) {
      for (const item of items) {
        query.append(param.name, item);
      }
    } else {
      query.append(param.name, items.join(','));
    }
    return;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined && item !== null);
    if (explode) {
      for (const [key, item] of entries) {
        query.append(key, scalar(param, item));
      }
    } else {
      query.append(param.name, entries.flatMap(([key, item]) => [key, scalar(param, item)]).join(','));
    }
    return;
  }
  query.append(param.name, scalar(param, value));
}

function scalar(param: ParamRoute, value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  throw new InvalidArguments(`${param.key} must be a string, number or boolean`);
}
