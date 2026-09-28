/** Dated OpenAPI tags: `openapi.vYYYYMMDD.N`. */
export const PUBLIC_OPENAPI_TAG = /^openapi\.v\d{8}\.\d+$/;

/** Newest matching tag, unless `FORGE_OPENAPI_RELEASE` pins one. */
export const PUBLIC_OPENAPI_REVISION = process.env['FORGE_OPENAPI_RELEASE'] ?? 'latest';

/** Pin URL. Unpinned consumers list releases and pick the newest `PUBLIC_OPENAPI_TAG`. */
export const PUBLIC_OPENAPI_URL = process.env['FORGE_OPENAPI_RELEASE']
  ? `https://github.com/cloudflare/forge/releases/download/${process.env['FORGE_OPENAPI_RELEASE']}/openapi.forge.json`
  : 'https://api.github.com/repos/cloudflare/forge/releases';
