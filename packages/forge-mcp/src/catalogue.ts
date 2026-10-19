/**
 * The tool catalogue: what the plugin writes and what the server serves.
 *
 * It is plain JSON. Each tool carries the fields `tools/list` sends, and a
 * `request` that says how `tools/call` turns the tool's arguments into one
 * HTTP request. Nothing about the OpenAPI document is needed at request time.
 */

/** The catalogue format. A server refuses a catalogue in a format it doesn't know. */
export const CATALOGUE_FORMAT = 'forge-mcp/1';

/** A JSON Schema, as JSON. */
export type JsonSchema = { readonly [key: string]: unknown };

export interface Catalogue {
  readonly format: typeof CATALOGUE_FORMAT;
  /** The API the tools call. */
  readonly api: {
    /** The document's `info.version`. */
    readonly version: string;
    /** The document's first server, which tools call unless the server is given another. */
    readonly baseUrl: string;
  };
  readonly tools: readonly CatalogueTool[];
  /** The methods that have no tool, and why. */
  readonly skipped: readonly SkippedMethod[];
}

export interface CatalogueTool {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  /** A self-contained JSON Schema 2020-12 object schema: models it uses are in its `$defs`. */
  readonly inputSchema: JsonSchema & { readonly type: 'object' };
  readonly annotations: ToolAnnotations;
  readonly request: RequestRoute;
  /**
   * Data a plugin adds for its own server, such as the permissions a method
   * needs. The runtime never sends it to clients.
   */
  readonly extensions?: { readonly [key: string]: unknown };
}

export interface ToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

/** How a tool's arguments become an HTTP request. */
export interface RequestRoute {
  /** As it is sent, such as `GET`. */
  readonly method: string;
  /** The path template, such as `/zones/{zone_id}/dns_records`. */
  readonly path: string;
  readonly params: readonly ParamRoute[];
  /** The argument that is the JSON body, if the method takes one. */
  readonly body?: { readonly key: string; readonly mediaType: string };
}

/** Where one argument goes. */
export interface ParamRoute {
  /** The argument's name in the tool's input. */
  readonly key: string;
  /** The parameter's name on the wire. */
  readonly name: string;
  readonly in: 'path' | 'query' | 'header';
  /** For a query parameter: whether an array or object is sent exploded (`a=1&a=2`) or not (`a=1,2`). */
  readonly explode?: boolean;
}

export interface SkippedMethod {
  readonly method: string;
  readonly path: string;
  readonly reason: string;
}

/** Whether `value` is a catalogue this version of the package can serve. */
export function isCatalogue(value: unknown): value is Catalogue {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { format, tools } = value as { format?: unknown; tools?: unknown };
  return format === CATALOGUE_FORMAT && Array.isArray(tools);
}
