/**
 * Build a forge plugin that writes an MCP tool catalogue.
 *
 * The default plugin, `plugin/forge-mcp.ts`, is this with no options. To
 * change which methods get tools, their names or the tools themselves, write
 * your own entry module:
 *
 * ```ts
 * import { definePlugin } from '@cloudflare/forge/plugin';
 * import { catalogueFile } from '@cloudflare/forge-mcp/plugin';
 *
 * export const { generate, generateGroup } = definePlugin({
 *   generate: (forge) => [catalogueFile(forge, { include: (method) => method.httpMethod === 'GET' })],
 * });
 * ```
 *
 * and build it with `forge-plugin build plugin.ts -o plugin.wasm`.
 *
 * @module
 */
import type { File, Forge } from '@cloudflare/forge/plugin';

import { buildCatalogue, type CatalogueOptions } from './tools.ts';

export type { Catalogue, CatalogueTool, ParamRoute, RequestRoute, SkippedMethod } from './catalogue.ts';
export { CATALOGUE_FORMAT } from './catalogue.ts';
export { buildCatalogue, defaultName, type CatalogueOptions } from './tools.ts';

/** The file the plugin writes. */
export const CATALOGUE_PATH = 'mcp-tools.json';

/** The catalogue of `forge`, as the file {@link CATALOGUE_PATH}. */
export function catalogueFile(forge: Forge, options?: CatalogueOptions): File {
  return { path: CATALOGUE_PATH, content: JSON.stringify(buildCatalogue(forge, options)) };
}
