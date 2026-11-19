import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { npmDir } from '../scripts/platforms.mjs';

const launcherSrc = join(npmDir, 'bin', 'forge.cjs');
const platformId = `${process.platform}-${process.arch}`;
const exe = process.platform === 'win32' ? 'forge.exe' : 'forge';
const expectedPkg = `@cloudflare/forge-${platformId}`;

/** Writes an executable POSIX stub binary that echoes `marker` and its args. */
function writeStubBinary(dest, marker) {
  mkdirSync(join(dest, '..'), { recursive: true });
  writeFileSync(dest, `#!/bin/sh\necho "${marker}:$*"\n`);
  chmodSync(dest, 0o755);
}

/** Copies bin/forge.cjs into a staged @cloudflare/forge directory. */
function stageMainPackage(dir) {
  const pkgDir = join(dir, 'node_modules', '@cloudflare', 'forge');
  mkdirSync(join(pkgDir, 'bin'), { recursive: true });
  const launcher = join(pkgDir, 'bin', 'forge.cjs');
  copyFileSync(launcherSrc, launcher);
  chmodSync(launcher, 0o755);
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@cloudflare/forge', version: '0.2.0', bin: { forge: 'bin/forge.cjs' } }),
  );
  return { pkgDir, launcher };
}

test('FORGE_BINARY overrides platform package resolution', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-launcher-env-'));
  try {
    const { launcher } = stageMainPackage(root);
    const customBin = join(root, 'custom-forge');
    writeStubBinary(customBin, 'from-env');

    const res = spawnSync(process.execPath, [launcher, '--version'], {
      env: { ...process.env, FORGE_BINARY: customBin },
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), 'from-env:--version');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'resolves binary from matching @cloudflare/forge-<os>-<cpu> package via require.resolve',
  { skip: process.platform === 'win32' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-launcher-optdep-'));
    try {
      const { launcher } = stageMainPackage(root);
      const platDir = join(root, 'node_modules', '@cloudflare', `forge-${platformId}`);
      mkdirSync(platDir, { recursive: true });
      writeFileSync(
        join(platDir, 'package.json'),
        JSON.stringify({
          name: expectedPkg,
          version: '0.2.0',
          os: [process.platform],
          cpu: [process.arch],
          files: [exe],
        }),
      );
      writeStubBinary(join(platDir, exe), `from-pkg-${platformId}`);

      const env = { ...process.env };
      delete env.FORGE_BINARY;
      const res = spawnSync(process.execPath, [launcher, '--version'], { env, encoding: 'utf8' });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stdout.trim(), `from-pkg-${platformId}:--version`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'falls back to bundled native/<os>-<cpu>/ binary when no platform package is installed',
  { skip: process.platform === 'win32' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-launcher-bundled-'));
    try {
      const { pkgDir, launcher } = stageMainPackage(root);
      writeStubBinary(join(pkgDir, 'native', platformId, exe), 'from-bundled');

      const env = { ...process.env };
      delete env.FORGE_BINARY;
      const res = spawnSync(process.execPath, [launcher, 'help'], { env, encoding: 'utf8' });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stdout.trim(), 'from-bundled:help');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('fails with clear error naming expected package when platform package is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-launcher-missing-'));
  try {
    const { launcher } = stageMainPackage(root);
    const env = { ...process.env };
    delete env.FORGE_BINARY;
    const res = spawnSync(process.execPath, [launcher, '--version'], { env, encoding: 'utf8' });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, new RegExp(expectedPkg.replace('/', '\\/')));
    assert.match(res.stderr, /--no-optional/);
    assert.match(res.stderr, /--omit=optional/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails with error naming expected package on an unsupported platform', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-launcher-unsupported-'));
  try {
    const { launcher } = stageMainPackage(root);
    const preload = join(root, 'fake-platform.cjs');
    writeFileSync(
      preload,
      "Object.defineProperty(process, 'platform', { value: 'freebsd' });\n" +
        "Object.defineProperty(process, 'arch', { value: 'riscv64' });\n",
    );
    const env = { ...process.env };
    delete env.FORGE_BINARY;
    const res = spawnSync(process.execPath, ['-r', preload, launcher, '--version'], {
      env,
      encoding: 'utf8',
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /@cloudflare\/forge-freebsd-riscv64/);
    assert.match(res.stderr, /freebsd-riscv64/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails naming expected package and available platforms when bundled tarball lacks current platform', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-launcher-bundled-mismatch-'));
  try {
    const { pkgDir, launcher } = stageMainPackage(root);
    const other = platformId === 'linux-x64' ? 'darwin-arm64' : 'linux-x64';
    const otherBin = join(pkgDir, 'native', other, 'forge');
    mkdirSync(join(otherBin, '..'), { recursive: true });
    writeFileSync(otherBin, 'stub');

    const env = { ...process.env };
    delete env.FORGE_BINARY;
    const res = spawnSync(process.execPath, [launcher, '--version'], { env, encoding: 'utf8' });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, new RegExp(expectedPkg.replace('/', '\\/')));
    assert.match(res.stderr, new RegExp(other));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
