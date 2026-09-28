import type { Forge } from './forge.js';
import { type ForgeOpenApiDocument, initFromOpenApi } from './init-from-openapi.js';
import { resolveApiOverlays, type ResolveOverlayOptions } from './overlay-source.js';
import type { ApiOverlay, ApiOverlayFile } from './overlay-types.js';

/**
 * Async factory — creates a fully-initialized Forge instance.
 *
 * This is a standalone async function rather than a constructor because the
 * initialization pipeline can be asynchronous when resolving overlays.
 *
 * @param openapi The base OpenAPI 3.x specification.
 * @param overlays Optional array of API overlays to apply.
 * @param options Resolution options (e.g. writeArtifacts, allowMissingOperations).
 * @returns A fully-initialized Forge instance.
 */
export async function init(
  openapi: ForgeOpenApiDocument,
  overlays: (ApiOverlay | ApiOverlayFile)[] = [],
  options?: ResolveOverlayOptions,
): Promise<Forge> {
  if (overlays.length === 0) {
    return initFromOpenApi(openapi);
  }

  const normalizedOverlays: ApiOverlayFile[] = overlays.map((item, i) =>
    'name' in item && 'overlay' in item
      ? (item as ApiOverlayFile)
      : { name: `overlay_${i}`, overlay: item as ApiOverlay },
  );

  const sorted = [...normalizedOverlays].sort((a, b) => a.name.localeCompare(b.name));
  const { overlaidOpenApi } = await resolveApiOverlays(sorted, openapi, options);

  return initFromOpenApi(overlaidOpenApi);
}

/**
 * Apply command and schema overlays to a complete bundled OpenAPI document.
 *
 * @param openapi The base OpenAPI document.
 * @param overlays Array of overlays to apply.
 * @param options Resolution options.
 * @returns The transformed OpenAPI document with overlays applied.
 */
export async function applyForgeOverlays(
  openapi: ForgeOpenApiDocument,
  overlays: (ApiOverlay | ApiOverlayFile)[] = [],
  options?: ResolveOverlayOptions,
): Promise<ForgeOpenApiDocument> {
  if (overlays.length === 0) {
    return openapi;
  }

  const normalizedOverlays: ApiOverlayFile[] = overlays.map((item, i) =>
    'name' in item && 'overlay' in item
      ? (item as ApiOverlayFile)
      : { name: `overlay_${i}`, overlay: item as ApiOverlay },
  );

  const sorted = [...normalizedOverlays].sort((a, b) => a.name.localeCompare(b.name));
  const { overlaidOpenApi } = await resolveApiOverlays(sorted, openapi, {
    writeArtifacts: false,
    allowMissingOperations: true,
    ...options,
  });

  return overlaidOpenApi as ForgeOpenApiDocument;
}
