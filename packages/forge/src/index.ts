/**
 * Reads and normalizes OpenAPI documents with forge, in the same process.
 *
 * `parse` parses a document with forge compiled to WebAssembly. It returns
 * the document's forge, with the same groups, methods, models and types a
 * plugin reads. `normalize` rewrites third-party metadata extensions into
 * Forge's native `x-forge-*` extensions before parsing.
 *
 * ```ts
 * import { normalize, parse } from "@cloudflare/forge";
 *
 * const forge = parse(normalize(await readFile("openapi.json", "utf8")));
 * for (const group of forge.groups) {
 *   console.log(group.path.join("."), group.methods.map((m) => m.name.camel()));
 * }
 * ```
 *
 * @module
 */

import { normalizer, parser } from './component/forge.js';
import type { Adapter } from './component/interfaces/forge-plugin-normalizer.js';
import { type Forge, forgeOf } from './forge.js';

export type { Adapter };
export type * from './forge.js';

/** Options for {@link normalize}. */
export interface NormalizeOptions {
  /**
   * Adapters to apply, in precedence order. Defaults to all built-in
   * adapters (`cloudflare`, `fern`, `stainless`).
   */
  readonly adapters?: readonly Adapter[];
  /**
   * Keeps rewritten keys alongside their native replacements instead of
   * removing them. Defaults to `false`.
   */
  readonly leaveOldExtensions?: boolean;
}

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

/**
 * Rewrites third-party metadata extensions in the OpenAPI JSON document `json`
 * into Forge's native `x-forge-*` extensions, matching `forge normalize`.
 * Returns `json` unchanged when nothing needed rewriting.
 */
export function normalize(json: string, options: NormalizeOptions = {}): string {
  try {
    return normalizer.normalize(json, {
      adapters: options.adapters ? [...options.adapters] : undefined,
      leaveOldExtensions: options.leaveOldExtensions ?? false,
    });
  } catch (err) {
    throw new Error(componentMessage(err));
  }
}

/** Returns the message of a component's error case, or of what was thrown. */
function componentMessage(err: unknown): string {
  const payload = (err as { payload?: unknown } | null)?.payload;
  if (typeof payload === 'string') {
    return payload;
  }
  return err instanceof Error ? err.message : String(err);
}
