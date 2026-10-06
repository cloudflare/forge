/**
 * @cloudflare/forge — Schema-first OpenAPI code-generation framework
 *
 * Provides the Forge class (plugin host for code-generation transformers),
 * typed OpenAPI resolvers, Schema types, overlay engine, and shared utilities.
 */

// Forge class, SourceFile, TransformerFn, MethodMapEntry
export * from './forge.js';
// Async factory — creates a fully-initialized Forge
export { applyForgeOverlays, init } from './init.js';
export { type ForgeOpenApiDocument, initFromOpenApi } from './init-from-openapi.js';
// OpenAPI sources: loader contract and registry, plus the JSON and YAML loaders
export * from './openapi-source.js';
export * from './openapi-file-loaders.js';
// OpenAPI resolver (operationId -> path/params/types)
export * from './openapi-resolver.js';
export * from './overlay-source.js';
export { PUBLIC_OPENAPI_REVISION, PUBLIC_OPENAPI_URL } from './public-openapi.js';

// Overlay types (for defining API product overlays)
export * from './overlay-types.js';

// Schema type system (Schema.command, Schema.method, etc.)
export * from './schema/schema.js';
// Shared utilities (naming, paths, HTTP, args, strings, etc.)
export * from './shared/index.js';
