// Generates src/wasm/schema.rs from packages/forge/src/schema.ts using capnstruct/codegen.
//
//     node scripts/schema.mjs [--check]

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toRustReprC } from 'capnstruct/codegen';
import { fail, npmDir, repoDir } from './platforms.mjs';

const check = process.argv.includes('--check');

try {
  // Compile schema.ts or import the built plugin/schema.js if present; Node 24 runs .ts directly with type stripping!
  const schemaPath = join(npmDir, 'src', 'schema.ts');
  const mod = await import(pathToFileURL(schemaPath).href);
  const raw = toRustReprC(mod.FORGE_SCHEMAS, {
    builder: true,
    wasmExports: 'all(target_arch = "wasm32", feature = "library")',
    unsafeSlice: false,
  });
  const rust = execFileSync('rustfmt', ['--edition', '2024'], {
    cwd: repoDir,
    input: raw,
    encoding: 'utf8',
  });
  const out = join(repoDir, 'src', 'wasm', 'schema.rs');
  if (check) {
    const current = readFileSync(out, 'utf8');
    if (current !== rust) {
      fail(
        'src/wasm/schema.rs is out of date with packages/forge/src/schema.ts; run `node packages/forge/scripts/schema.mjs`',
      );
    }
    console.log(`${out} is up to date`);
  } else {
    writeFileSync(out, rust);
    console.log(`wrote ${out} (${rust.split('\n').length} lines)`);
  }
} catch (err) {
  fail(err);
}
