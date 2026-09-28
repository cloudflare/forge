/// <reference types="astro/client" />
/// <reference types="astro-fern/locals" />

declare module 'cloudflare:workers' {
  export const env: { ASSETS: import('astro-fern/live').FernArtifactFetcher };
}
