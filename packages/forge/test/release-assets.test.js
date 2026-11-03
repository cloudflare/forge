import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { platforms } from '../scripts/platforms.mjs';

const script = join(import.meta.dirname, '..', 'scripts', 'release-assets.mjs');

test('release assets contain every native binary, the npm package and checksums', () => {
  const fixture = releaseFixture();
  try {
    const result = run(fixture, 'v0.1.0');
    assert.equal(result.status, 0, result.stderr);

    const archives = platforms.map(({ id }) => `forge-0.1.0-${id}.tar.gz`);
    const assets = ['SHA256SUMS', 'cloudflare-forge-0.1.0.tgz', ...archives].sort();
    assert.deepEqual(readdirSync(fixture.out).sort(), assets);

    for (const line of readFileSync(join(fixture.out, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
      const [want, name] = line.split('  ');
      const have = createHash('sha256')
        .update(readFileSync(join(fixture.out, name)))
        .digest('hex');
      assert.equal(have, want, name);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('release assets reject a tag that differs from Cargo and npm', () => {
  const fixture = releaseFixture();
  try {
    const result = run(fixture, 'v9.9.9');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release tag v9\.9\.9 does not match Cargo and npm version 0\.1\.0/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function releaseFixture() {
  const root = mkdtempSync(join(tmpdir(), 'forge-release-test-'));
  const artifacts = join(root, 'binaries');
  for (const platform of platforms) {
    const dir = join(artifacts, platform.target, 'release');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, platform.exe), `forge for ${platform.id}\n`);
  }
  const npmArchive = join(root, 'cloudflare-forge-0.1.0.tgz');
  writeFileSync(npmArchive, 'npm package\n');
  return { root, artifacts, npmArchive, out: join(root, 'out') };
}

function run(fixture, tag) {
  return spawnSync(
    process.execPath,
    [script, '--artifacts', fixture.artifacts, '--npm-archive', fixture.npmArchive, '--out', fixture.out, '--tag', tag],
    { encoding: 'utf8' },
  );
}
