/**
 * Reads OpenAPI documents with forge, in the same process.
 *
 * `parse` parses a document with forge compiled to WebAssembly. It returns
 * the document's forge, with the same groups, methods, models and types a
 * plugin reads.
 *
 * ```ts
 * import { parse } from "@cloudflare/forge";
 *
 * const forge = parse(await readFile("openapi.json", "utf8"), { adapters: ["fern"] });
 * for (const group of forge.groups) {
 *   console.log(group.path.join("."), group.methods.map((m) => m.name.camel()));
 * }
 * ```
 *
 * @module
 */

import { parser } from './component/forge.js';
import { type Forge, forgeOf } from './forge.js';

export type * from './forge.js';

/**
 * Names another tool, so forge reads the tool's metadata extensions as its
 * own `x-forge-*` ones. Forge rewrites them in the same way as
 * `forge normalize --from`. With `fern`, for example, forge reads
 * `x-fern-sdk-group-name` as `x-forge-group-name`.
 */
export type Adapter = 'cloudflare' | 'fern' | 'stainless';

/** Says how {@link parse} reads a document. */
export interface ParseOptions {
  /**
   * Lists the tools to read extensions from, besides forge's own. Without
   * it, `parse` reads only the native `x-forge-*` extensions.
   */
  readonly adapters?: readonly Adapter[];
}

/**
 * Parses the OpenAPI JSON document `json` and returns its forge. Throws with
 * forge's message when forge doesn't read the document, such as one that is
 * not OpenAPI 3.x, or one with two methods of the same name in a group.
 */
export function parse(json: string, options: ParseOptions = {}): Forge {
  let parsed: ReturnType<typeof parser.parse>;
  try {
    parsed = parser.parse(json, [...(options.adapters ?? [])]);
  } catch (err) {
    throw new Error(componentMessage(err));
  }
  return forgeOf(parsed);
}

/** Returns the message of a component's error case, or of what was thrown. */
function componentMessage(err: unknown): string {
  const payload = (err as { payload?: unknown } | null)?.payload;
  if (typeof payload === 'string') {
    return payload;
  }
  return err instanceof Error ? err.message : String(err);
}
