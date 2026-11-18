/**
 * Read OpenAPI documents with forge, in the same process.
 *
 * `parse` parses a document with forge compiled to WebAssembly, and returns
 * its forge: the same groups, methods, models and types a plugin reads.
 *
 * ```ts
 * import { parse } from "@cloudflare/forge";
 *
 * using forge = parse(await readFile("openapi.json", "utf8"));
 * for (const group of forge.groups) {
 *   console.log(group.path.join("."), group.methods.map((m) => m.name.camel()));
 * }
 * ```
 *
 * @module
 */

import { document } from './component/forge.js';
import { type Forge, forgeOf } from './forge.js';

export type * from './forge.js';

/**
 * A parsed document's forge. It holds the document in forge's memory until
 * it is disposed: dispose it, or declare it with `using`, when done.
 */
export interface Document extends Forge, Disposable {
  /**
   * Frees the document. A part already read stays readable; reading one
   * for the first time afterwards throws.
   */
  dispose(): void;
}

/**
 * Parses `json`, an OpenAPI JSON document, and returns its forge. Throws
 * with forge's message if forge doesn't read it, such as a document that is
 * not OpenAPI 3.x or two methods with the same name in a group.
 */
export function parse(json: string): Document {
  let parsed: document.Document;
  try {
    parsed = document.Document.parse(json);
  } catch (err) {
    throw new Error(componentMessage(err));
  }
  const forge = forgeOf(parsed);
  const dispose = () => parsed[disposeSymbol]();
  return Object.assign(forge, { dispose, [disposeSymbol]: dispose });
}

/**
 * `Symbol.dispose`, which Node has from 18.18 and 20.4, or the symbol jco's
 * resources use without it.
 */
const disposeSymbol: typeof Symbol.dispose = Symbol.dispose ?? (Symbol.for('dispose') as typeof Symbol.dispose);

/** The string a component's error case carries, or what was thrown. */
function componentMessage(err: unknown): string {
  const payload = (err as { payload?: unknown } | null)?.payload;
  if (typeof payload === 'string') {
    return payload;
  }
  return err instanceof Error ? err.message : String(err);
}
