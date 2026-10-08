import type { FernArtifactFetcher } from 'astro-fern/live';

/** Requires the static-asset binding used by this Cloudflare deployment. */
export function requireAssetFetcher(value: FernArtifactFetcher | undefined): FernArtifactFetcher {
  if (!value || typeof value.fetch !== 'function') {
    throw new Error('docs-site: the Cloudflare ASSETS binding is required to load API operation artifacts');
  }
  return value;
}
