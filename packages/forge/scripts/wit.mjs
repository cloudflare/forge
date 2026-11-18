// Copies the WIT that wasm plugins are built against, from
// src/plugin/forge.wit, into plugin/forge.wit:
//
//     node scripts/wit.mjs
//
// Run it whenever src/plugin/forge.wit changes. scripts/archive.mjs
// refuses to pack a stale copy.

import { readFileSync, writeFileSync } from 'node:fs';

import { display, fail, witPath, witSource } from './platforms.mjs';

try {
  const wit = witSource();
  const have = (() => {
    try {
      return readFileSync(witPath, 'utf8');
    } catch {
      return undefined;
    }
  })();
  if (have === wit) {
    console.log(`${display(witPath)} is current`);
  } else {
    writeFileSync(witPath, wit);
    console.log(`updated ${display(witPath)}`);
  }
} catch (err) {
  fail(err);
}
