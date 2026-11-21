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
 * using forge = parse(await readFile("openapi.json", "utf8"));
 * for (const group of forge.groups) {
 *   console.log(group.path.join("."), group.methods.map((m) => m.name.camel()));
 * }
 * ```
 *
 * @module
 */

import { coreModules } from './component/core.js';
import { instantiate } from './component/forge.js';
import { type Forge, forgeOf } from './forge.js';

export type * from './forge.js';

/**
 * Holds a parsed document's forge in forge's memory until disposed. Dispose
 * it, or declare it with `using`, when done.
 */
export interface Document extends Forge, Disposable {
  /**
   * Frees the document. A part already read stays readable; reading one
   * for the first time afterwards throws.
   */
  dispose(): void;
}

/**
 * Parses the OpenAPI JSON document `json` and returns its forge. Throws with
 * forge's message when forge doesn't read the document, such as one that is
 * not OpenAPI 3.x, or one with two methods of the same name in a group.
 *
 * Runs each document in an instance of forge of its own. A document that
 * makes forge fail leaves the other documents readable, and a disposed
 * document's memory goes with its instance.
 */
export function parse(json: string): Document {
  // The component exports everything it has and imports nothing.
  const { parser } = instantiate(coreModule, {});
  let parsed: Parsed;
  try {
    parsed = parser.parse(json);
  } catch (err) {
    throw new Error(componentMessage(err));
  }
  const forge = forgeOf(parsed);
  // jco gives every resource a dispose method, but its types leave it out.
  const dispose = () => (parsed as Parsed & Disposable)[disposeSymbol]();
  return Object.assign(forge, { dispose, [disposeSymbol]: dispose });
}

/** Holds the `forge` resource `parse` gets from the component. */
type Parsed = ReturnType<ReturnType<typeof instantiate>['parser']['parse']>;

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

/**
 * Holds `Symbol.dispose`. Node added it in 18.18 and 20.4, so older versions
 * get the symbol jco's resources use instead.
 */
const disposeSymbol: typeof Symbol.dispose = Symbol.dispose ?? (Symbol.for('dispose') as typeof Symbol.dispose);

/** Returns the message of a component's error case, or of what was thrown. */
function componentMessage(err: unknown): string {
  const payload = (err as { payload?: unknown } | null)?.payload;
  if (typeof payload === 'string') {
    return payload;
  }
  return err instanceof Error ? err.message : String(err);
}
