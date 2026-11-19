/**
 * Write forge plugins in TypeScript or JavaScript.
 *
 * A plugin generates files from the forge of an OpenAPI document: its
 * groups, methods, models and types, as forge's Rust API has them. Build it
 * with `forge-plugin build`, and run it with
 * `forge generate openapi.json --target wasm://plugin.wasm --out sdk`.
 *
 * ```ts
 * import { definePlugin } from "@cloudflare/forge/plugin";
 *
 * export const { generate } = definePlugin({
 *   generate(forge) {
 *     return forge.groups.map((group) => {
 *       const names = group.methods.map((m) => m.name.camel());
 *       const path = [...group.path.map((name) => name.kebab()), "methods.txt"].join("/");
 *       return { path, content: names.join("\n") };
 *     });
 *   },
 * });
 * ```
 *
 * The forge stays in forge's process. Each part is fetched the first time
 * a plugin reads it, and kept for the rest of the call, so reading a part
 * again is free, and the same part is always the same object: compare
 * groups, methods and models with `===`.
 *
 * @module
 */

// This file is the source of plugin/plugin.js and plugin/plugin.d.ts, which
// scripts/build.mjs compiles it to. It is typed against the bindings jco
// generates from plugin/forge.wit, so a change to the WIT that this library
// doesn't follow fails to compile. Its exports are interfaces, and the
// classes behind them stay private, so the bindings never show in
// index.d.ts.

import type * as hostPlugin from 'forge:plugin/plugin@0.4.0';

import { type Forge, forgeOf } from './forge.js';

export type * from './forge.js';

// ---------------------------------------------------------------------------
// The API.

/** A plugin: what {@link definePlugin} takes. */
export interface Plugin {
  /**
   * Generates every file for the forge, such as some for each of
   * `forge.groups`. Called exactly once, in a fresh instance, on one
   * thread.
   */
  generate(forge: Forge): Iterable<File>;
}

/**
 * A file a plugin generates.
 *
 * forge writes it to the output directory, creating directories it needs,
 * and skips a file with no content. It rejects a path that is absolute,
 * has `.` or `..` parts, or that two files share.
 */
export interface File {
  /** The path relative to the output directory, using `/` as a separator. */
  path: string;
  /** The content: text, which is written as UTF-8, or bytes. */
  content: string | Uint8Array;
}

/** What the entry module of a plugin exports, under these names. */
export interface Exports {
  /** Takes the capnstruct `ForgeDoc` buffer the host passes. */
  generate(forge: Uint8Array): Array<{ path: string; content: Uint8Array }>;
}

/**
 * Returns the exports of a plugin that calls `plugin`. Export them from the
 * plugin's entry module:
 *
 * ```ts
 * export const { generate } = definePlugin({ ... });
 * ```
 *
 * Throw to fail: forge stops and prints the error's message.
 */
export function definePlugin(plugin: Plugin): Exports {
  const exports = {
    generate(forge: Uint8Array) {
      return call(() => files(plugin.generate(forgeOf(forge))));
    },
  } satisfies Pick<typeof hostPlugin, 'generate'>;
  return exports;
}

// ---------------------------------------------------------------------------
// Writing what a plugin returns.

/**
 * Runs `f`, turning whatever it throws into the string the WIT's error
 * case carries.
 */
function call<T>(f: () => T): T {
  try {
    return f();
  } catch (err) {
    throw err instanceof Error ? err.message : String(err);
  }
}

/** Returns `files` as the host takes them, with their content in bytes. */
function files(files: Iterable<File>): hostPlugin.File[] {
  return Array.from(files, (file) => {
    if (typeof file?.path !== 'string') {
      throw new Error(`a file needs a path, not ${JSON.stringify(file?.path)}`);
    }
    const content = file.content ?? '';
    return { path: file.path, content: typeof content === 'string' ? encode(content) : content };
  });
}

type Encoder = { encode(s: string): Uint8Array };
const NativeEncoder = (globalThis as { TextEncoder?: new () => Encoder }).TextEncoder;

/**
 * Encodes `s` in UTF-8. QuickJS has no TextEncoder, so `s` is encoded here:
 * a code unit at a time, into one buffer as large as UTF-8 can need, which
 * is several times faster than building an array of bytes. A lone surrogate
 * is written as its own three bytes.
 */
const encode: (s: string) => Uint8Array = NativeEncoder
  ? (s) => new NativeEncoder().encode(s)
  : (s) => {
      const out = new Uint8Array(s.length * 3);
      let n = 0;
      for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (c < 0x80) {
          out[n++] = c;
        } else if (c < 0x800) {
          out[n++] = 0xc0 | (c >> 6);
          out[n++] = 0x80 | (c & 63);
        } else {
          const next = c >= 0xd800 && c < 0xdc00 ? s.charCodeAt(i + 1) : 0;
          if (next >= 0xdc00 && next < 0xe000) {
            c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
            i++;
            out[n++] = 0xf0 | (c >> 18);
            out[n++] = 0x80 | ((c >> 12) & 63);
          } else {
            out[n++] = 0xe0 | (c >> 12);
          }
          out[n++] = 0x80 | ((c >> 6) & 63);
          out[n++] = 0x80 | (c & 63);
        }
      }
      return out.slice(0, n);
    };
