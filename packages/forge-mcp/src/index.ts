/**
 * Serve an MCP tool catalogue that the forge-mcp plugin generated, over
 * Streamable HTTP.
 *
 * ```ts
 * import { createForgeMcpHandler } from '@cloudflare/forge-mcp';
 * import catalogue from './mcp-tools.json';
 *
 * const mcp = createForgeMcpHandler({
 *   catalogue,
 *   authorize: (request) => {
 *     const authorization = request.headers.get('Authorization');
 *     return authorization ? { Authorization: authorization } : new Response('Unauthorized', { status: 401 });
 *   },
 * });
 *
 * export default { fetch: (request: Request) => mcp.fetch(request) };
 * ```
 *
 * @module
 */
export {
  CATALOGUE_FORMAT,
  isCatalogue,
  type Catalogue,
  type CatalogueTool,
  type JsonSchema,
  type ParamRoute,
  type RequestRoute,
  type SkippedMethod,
  type ToolAnnotations,
} from './catalogue.ts';
export { buildRequest, InvalidArguments } from './request.ts';
export { callTool, createForgeMcpHandler, serveCatalogue, type CallContext, type ForgeMcpOptions } from './server.ts';
