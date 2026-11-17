#!/usr/bin/env node
// Rewrites relative `.ts` import specifiers in emitted .d.ts files to `.js`.
// TypeScript's `rewriteRelativeImportExtensions` rewrites the extension in
// emitted .js files but leaves .d.ts files untouched, which breaks consumers
// that resolve the published types without `allowImportingTsExtensions`.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
if (root === undefined) {
  console.error('usage: rewrite-dts-extensions.mjs <dir>');
  process.exit(2);
}

// Match `from '...ts'` and `from "...ts"` for relative specifiers, plus
// `import '...ts'` side-effect specifiers. Keeps the quote style.
const pattern = /((?:from|import)\s*)(['"])(\.\.?\/[^'"]+?)\.ts\2/g;

function rewrite(file) {
  const before = readFileSync(file, 'utf8');
  const after = before.replace(pattern, (_, kw, quote, path) => `${kw}${quote}${path}.js${quote}`);
  if (before !== after) {
    writeFileSync(file, after);
  }
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full);
    } else if (entry.endsWith('.d.ts')) {
      rewrite(full);
    }
  }
}

walk(root);
