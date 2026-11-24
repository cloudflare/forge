import type { ApiSpecSource, NimbusConfig } from '@cloudflare/nimbus-docs/types';

const FORGE_RELEASES_URL = new URL('https://github.com/cloudflare/forge/releases/');
const FORGE_OPENAPI_ASSET = 'openapi.forge.json';

export function forgeOpenApiUrl(release = process.env['FORGE_OPENAPI_RELEASE']): URL {
  const revision = release?.trim();
  const assetPath = revision
    ? `download/${encodeURIComponent(revision)}/${FORGE_OPENAPI_ASSET}`
    : `latest/download/${FORGE_OPENAPI_ASSET}`;
  return new URL(assetPath, FORGE_RELEASES_URL);
}

/**
 * Where the spec comes from: the file `FORGE_OPENAPI_SPEC` names, or else the
 * `openapi.forge.json` asset of a Forge release, which Nimbus fetches as a
 * URL source and asks about again (one conditional request) on each build.
 */
export function forgeOpenApiSource(
  specPath = process.env['FORGE_OPENAPI_SPEC'],
  release = process.env['FORGE_OPENAPI_RELEASE'],
): { sources?: NimbusConfig['sources']; spec: string | ApiSpecSource } {
  if (specPath) return { spec: specPath };
  return { sources: { forge: { url: forgeOpenApiUrl(release).href } }, spec: { source: 'forge' } };
}
