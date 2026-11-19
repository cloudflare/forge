// Generates src/wasm/schema.rs from packages/forge/src/schema.ts using capnstruct/codegen.
//
//     node scripts/schema.mjs

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { toRustReprC } from 'capnstruct/codegen';

import { fail, npmDir, repoDir } from './platforms.mjs';

try {
  // Compile schema.ts or import the built plugin/schema.js if present; Node 24 runs .ts directly with type stripping!
  const schemaPath = join(npmDir, 'src', 'schema.ts');
  const mod = await import(pathToFileURL(schemaPath).href);
  const rust = toRustReprC(mod.FORGE_SCHEMAS, {
    builder: true,
    wasmExports: 'all(target_arch = "wasm32", feature = "library")',
  });
  const out = join(repoDir, 'src', 'wasm', 'schema.rs');
  writeFileSync(out, rust);
  console.log(`wrote ${out} (${rust.split('\n').length} lines)`);
} catch (err) {
  fail(err);
}
