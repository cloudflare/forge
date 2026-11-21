// Minimal synchronous WebAssembly loader for forge's plain wasm32-unknown-unknown
// cdylib (replaces the 164 KB jco-transpiled component runtime).
import { readFileSync } from 'node:fs';

const wasmBytes = readFileSync(new URL('./forge.wasm', import.meta.url));
const instance = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {});
const { memory, capn_alloc, capn_reset, forge_parse, forge_out_ptr, forge_out_len, forge_clear_out } = instance.exports;
const hasNodeBuffer = typeof Buffer === 'function';
const encoder = hasNodeBuffer ? null : new TextEncoder();
const decoder = new TextDecoder();

/**
 * Parses an OpenAPI JSON string inside the WASM module, returns a standalone
 * `Uint8Array` holding the capnstruct `ForgeDoc` buffer, and immediately frees
 * the WASM output/scratch buffers so repeated parses never leak WASM memory.
 */
export function parseToCapnBuffer(json) {
  let inPtr;
  let inLen;
  if (hasNodeBuffer) {
    inLen = Buffer.byteLength(json, 'utf8');
    inPtr = capn_alloc(inLen) >>> 0;
    Buffer.from(memory.buffer, inPtr, inLen).write(json, 0, inLen, 'utf8');
  } else {
    const input = encoder.encode(json);
    inLen = input.byteLength;
    inPtr = capn_alloc(inLen) >>> 0;
    new Uint8Array(memory.buffer, inPtr, inLen).set(input);
  }
  try {
    const rc = forge_parse(inPtr, inLen);
    const outPtr = forge_out_ptr() >>> 0;
    const outLen = forge_out_len() >>> 0;
    const out = new Uint8Array(memory.buffer, outPtr, outLen).slice();
    if (rc !== 0) {
      throw new Error(decoder.decode(out));
    }
    return out;
  } finally {
    forge_clear_out();
    capn_reset();
  }
}
