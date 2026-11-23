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
 * const forge = parse(await readFile("openapi.json", "utf8"));
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
 * Parses the OpenAPI JSON document `json` and returns its forge. Throws with
 * forge's message when forge doesn't read the document, such as one that is
 * not OpenAPI 3.x, or one with two methods of the same name in a group.
 */
export function parse(json: string): Forge {
  let parsed: ReturnType<typeof parser.parse>;
  try {
    parsed = parser.parse(json);
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
