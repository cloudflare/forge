import { createMcpHandler, McpServer, type CallToolResult, type Tool } from '@modelcontextprotocol/server';

import { isCatalogue, type Catalogue, type CatalogueTool } from './catalogue.ts';
import { buildRequest, InvalidArguments } from './request.ts';

/** What a tool call needs besides the tool and its arguments. */
export interface CallContext {
  /** The API's base URL. */
  baseUrl: string;
  /** Headers every API call sends, such as `Authorization`. */
  headers?: HeadersInit;
  fetch?: (request: Request) => Promise<Response>;
  /** Turns a response body into the tool result's text. By default JSON is pretty-printed and text is kept. */
  formatResult?: (body: unknown, response: Response) => string;
}

export interface ForgeMcpOptions {
  /** The catalogue, or a function that loads it. A loaded catalogue is kept for the life of the handler. */
  catalogue: Catalogue | (() => Catalogue | Promise<Catalogue>);
  serverInfo?: { name: string; version: string };
  instructions?: string;
  /** The API's base URL. Defaults to the catalogue's. */
  baseUrl?: string;
  /**
   * Called before each MCP request is served. Return the headers its API calls
   * send, such as the caller's `Authorization`, or a response to refuse it.
   */
  authorize?: (request: Request) => HeadersInit | Response | undefined | Promise<HeadersInit | Response | undefined>;
  fetch?: (request: Request) => Promise<Response>;
  formatResult?: CallContext['formatResult'];
}

/**
 * An MCP server over Streamable HTTP that serves a catalogue's tools: a
 * `fetch` to call from a Worker or any server with web-standard requests.
 *
 * Each request gets a fresh, stateless MCP server, as the SDK serves the
 * 2026-07-28 protocol and stateless 2025 clients. `tools/list` returns the
 * catalogue's tools, built once; `tools/call` makes one API request.
 */
export function createForgeMcpHandler(options: ForgeMcpOptions): { fetch(request: Request): Promise<Response> } {
  const load = catalogueLoader(options.catalogue);
  const serverInfo = options.serverInfo ?? { name: 'forge-mcp', version: '0.1.0' };

  return {
    async fetch(request) {
      const authorized = options.authorize ? await options.authorize(request) : undefined;
      if (authorized instanceof Response) {
        return authorized;
      }
      const catalogue = await load();
      const context: CallContext = {
        baseUrl: options.baseUrl ?? catalogue.api.baseUrl,
        ...(authorized && { headers: authorized }),
        ...(options.fetch && { fetch: options.fetch }),
        ...(options.formatResult && { formatResult: options.formatResult }),
      };
      const handler = createMcpHandler(() => {
        const server = new McpServer(serverInfo, options.instructions ? { instructions: options.instructions } : {});
        serveCatalogue(server, catalogue, (tool, args) => callTool(tool, args, context));
        return server;
      });
      return handler.fetch(request);
    },
  };
}

/**
 * Serves a catalogue's tools on an existing server, with low-level handlers:
 * no per-tool registration, which for thousands of tools costs more than the
 * request. `call` makes the API request; {@link callTool} is the default.
 */
export function serveCatalogue(
  server: McpServer,
  catalogue: Catalogue,
  call: (tool: CatalogueTool, args: Record<string, unknown>) => Promise<CallToolResult>,
): void {
  const { list, byName } = catalogueTools(catalogue);
  server.server.registerCapabilities({ tools: { listChanged: false } });
  // The SDK types the list as mutable; it only serializes it.
  server.server.setRequestHandler('tools/list', () => ({ tools: list as Tool[] }));
  server.server.setRequestHandler('tools/call', async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      return errorResult(`Unknown tool: ${request.params.name}`);
    }
    return call(tool, request.params.arguments ?? {});
  });
}

/**
 * Calls one tool: builds its request, sends it, and returns the response as
 * the result. A non-2xx response is a result with `isError: true`, not a
 * protocol error, so the model sees what the API said.
 */
export async function callTool(
  tool: CatalogueTool,
  args: Record<string, unknown>,
  context: CallContext,
): Promise<CallToolResult> {
  let request: Request;
  try {
    request = buildRequest(tool, args, context.baseUrl);
  } catch (err) {
    if (err instanceof InvalidArguments) {
      return errorResult(err.message);
    }
    throw err;
  }
  if (context.headers) {
    for (const [name, value] of new Headers(context.headers)) {
      request.headers.set(name, value);
    }
  }

  const response = await (context.fetch ?? fetch)(request);
  const type = response.headers.get('Content-Type') ?? '';
  const raw = await response.text();
  let body: unknown = raw;
  if (type.includes('json') && raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      // Not the JSON it says it is: keep the text.
    }
  }
  const text = (context.formatResult ?? defaultFormat)(body, response);
  return { content: [{ type: 'text', text }], ...(!response.ok && { isError: true }) };
}

function defaultFormat(body: unknown, response: Response): string {
  const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  return response.ok ? text : `${response.status} ${response.statusText}\n${text}`.trim();
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** A catalogue's tools as `tools/list` sends them, and a lookup by name. */
export interface CatalogueTools {
  /** Each tool without its `request` and `extensions`. The same array every time. */
  readonly list: readonly Tool[];
  readonly byName: ReadonlyMap<string, CatalogueTool>;
}

const servedCatalogues = new WeakMap<Catalogue, CatalogueTools>();

/**
 * A catalogue's `tools/list` payload and name lookup, built once per
 * catalogue. For a server that lists other tools too and dispatches itself.
 */
export function catalogueTools(catalogue: Catalogue): CatalogueTools {
  let entry = servedCatalogues.get(catalogue);
  if (!entry) {
    entry = {
      list: catalogue.tools.map(({ request: _request, extensions: _extensions, ...tool }) => tool as Tool),
      byName: new Map(catalogue.tools.map((tool) => [tool.name, tool])),
    };
    servedCatalogues.set(catalogue, entry);
  }
  return entry;
}

/** Loads the catalogue once. A failed load is retried on the next request. */
function catalogueLoader(source: ForgeMcpOptions['catalogue']): () => Promise<Catalogue> {
  let loading: Promise<Catalogue> | undefined;
  return () => {
    loading ??= (async () => {
      const catalogue = typeof source === 'function' ? await source() : source;
      if (!isCatalogue(catalogue)) {
        throw new Error('Not a forge-mcp/1 catalogue');
      }
      return catalogue;
    })();
    loading.catch(() => {
      loading = undefined;
    });
    return loading;
  };
}
