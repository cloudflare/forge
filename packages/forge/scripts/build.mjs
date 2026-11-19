// Builds the package's libraries, @cloudflare/forge and
// @cloudflare/forge/plugin, into <dir>, plugin/ unless --out says otherwise:
//
//     node scripts/build.mjs [--out <dir>]
//
// buildPlugin in scripts/platforms.mjs lists the steps. A WIT the libraries
// don't follow fails to compile.
//
// scripts/archive.mjs runs it too. It needs this directory's dev
// dependencies: run pnpm install here first.

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { buildPlugin, fail } from './platforms.mjs';

try {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  buildPlugin(values.out && resolve(values.out));
} catch (err) {
  fail(err);
}
