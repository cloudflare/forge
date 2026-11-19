#!/usr/bin/env node
// Clean `dist/` and compile with tsc. Invoked by `pnpm run build`.
// A dedicated script keeps the tsc invocation out of package.json's
// quoting rules and works the same on Windows (no `rm -rf`).

import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

rmSync(resolve(pkgDir, 'dist'), { recursive: true, force: true });

const { status } = spawnSync('tsc', ['-p', 'tsconfig.build.json'], {
  cwd: pkgDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

process.exit(status ?? 1);
