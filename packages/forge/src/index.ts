/**
 * Reads OpenAPI documents with forge, in the same process.
 *
 * `parse` parses a document with forge compiled to WebAssembly into a single
 * self-contained `capnstruct` binary buffer. It returns the document's forge,
 * with the same groups, methods, models and types a plugin reads.
 *
 * @module
 */

import { type Forge, forgeOf } from './forge.js';
import { parseToCapnBuffer } from './wasm-loader.js';

export type * from './forge.js';

/**
 * Holds a parsed document's forge backed by a standalone `Uint8Array`.
 * Disposal is optional (standard JS GC reclaims the buffer automatically),
 * and `dispose()` / `using` immediately releases the backing buffer reference.
 */
export interface Document extends Forge, Disposable {
  /**
   * Releases the backing buffer. Parts already read stay readable; reading an
   * unread part afterwards throws.
   */
  dispose(): void;
}

/**
 * Parses the OpenAPI JSON document `json` and returns its forge. Throws with
 * forge's message when forge doesn't read the document, such as one that is
 * not OpenAPI 3.x, or one with two methods of the same name in a group.
 */
export function parse(json: string): Document {
  const bytes = parseToCapnBuffer(json);
  const forge = forgeOf(bytes);
  const dispose = () => forge._dispose();
  return Object.assign(forge, { dispose, [disposeSymbol]: dispose });
}

const disposeSymbol: typeof Symbol.dispose = Symbol.dispose ?? (Symbol.for('dispose') as typeof Symbol.dispose);
