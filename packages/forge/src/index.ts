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

import { coreModules } from './component/core.js';
import { type ImportObject, instantiate } from './component/forge.js';
import { type Forge, forgeOf } from './forge.js';

export type * from './forge.js';

/**
 * Parses the OpenAPI JSON document `json` and returns its forge. Throws with
 * forge's message when forge doesn't read the document, such as one that is
 * not OpenAPI 3.x, or one with two methods of the same name in a group.
 *
 * Runs each document in an instance of forge of its own, dropped once the
 * forge is copied out. A document that makes forge fail leaves the other
 * documents readable, and the memory forge grew to read a document goes with
 * its instance.
 */
export function parse(json: string): Forge {
  // The component imports only forge's interface, which holds types and no
  // functions, so it needs no imports.
  const { parser } = instantiate(coreModule, {} as ImportObject);
  let parsed: ReturnType<typeof parser.parse>;
  try {
    parsed = parser.parse(json);
  } catch (err) {
    throw new Error(componentMessage(err));
  }
  return forgeOf(parsed);
}

/** Caches the core modules, each compiled the first time a document needs it. */
const compiled = new Map<string, WebAssembly.Module>();

/** Returns the compiled core module `name`, for the component to instantiate. */
function coreModule(name: string): WebAssembly.Module {
  let module = compiled.get(name);
  if (module === undefined) {
    const base64 = coreModules[name];
    if (base64 === undefined) {
      throw new Error(`forge has no core module ${name}`);
    }
    module = new WebAssembly.Module(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
    compiled.set(name, module);
  }
  return module;
}

/** Returns the message of a component's error case, or of what was thrown. */
function componentMessage(err: unknown): string {
  const payload = (err as { payload?: unknown } | null)?.payload;
  if (typeof payload === 'string') {
    return payload;
  }
  return err instanceof Error ? err.message : String(err);
}
