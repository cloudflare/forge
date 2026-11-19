import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

import { archive } from '../scripts/archive.mjs';
import { checkVersion, platforms, platformTarball, tarball } from '../scripts/platforms.mjs';

const execFileAsync = promisify(execFile);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * Parses a gzipped ustar tarball into a Map of entry path -> { mode, content }.
 */
function readTarball(tgzPath) {
  const buf = gunzipSync(readFileSync(tgzPath));
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) {
      break;
    }
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const fullName = prefix ? `${prefix}/${name}` : name;
    const mode = Number.parseInt(header.subarray(100, 108).toString('utf8').replace(/\0.*$/, '').trim(), 8);
    const size = Number.parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8);
    offset += 512;
    const content = Buffer.from(buf.subarray(offset, offset + size));
    entries.set(fullName, { mode, content });
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** Populates a temporary artifacts directory with stub binaries for `list`. */
function createStubArtifacts(dir, version, list = platforms) {
  for (const platform of list) {
    const dest = join(dir, platform.target, 'release', platform.exe);
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, `#!/bin/sh\necho "forge ${version} ${platform.id}"\n`);
    chmodSync(dest, 0o755);
  }
}

test('archive packs six per-platform tarballs plus main tarball with optionalDependencies', () => {
  const version = checkVersion();
  const root = mkdtempSync(join(tmpdir(), 'forge-archive-test-'));
  try {
    const artifacts = join(root, 'binaries');
    const out = join(root, 'dist');
    createStubArtifacts(artifacts, version);

    const packed = archive(artifacts, undefined, out);
    assert.equal(packed.length, platforms.length + 1);

    // Inspect each platform tarball.
    for (const platform of platforms) {
      const tgz = platformTarball(out, version, platform);
      assert.ok(existsSync(tgz), `expected ${tgz}`);
      const entries = readTarball(tgz);

      const pkgEntry = entries.get('package/package.json');
      assert.ok(pkgEntry, `${platform.pkg} missing package.json`);
      const pkg = JSON.parse(pkgEntry.content.toString('utf8'));
      assert.equal(pkg.name, platform.pkg);
      assert.equal(pkg.version, version);
      assert.deepEqual(pkg.os, [platform.os]);
      assert.deepEqual(pkg.cpu, [platform.cpu]);
      assert.equal(pkg.license, 'Apache-2.0');
      assert.deepEqual(pkg.files, [platform.exe]);
      assert.equal(pkg.publishConfig?.access, 'public');
      assert.equal(pkg.publishConfig?.provenance, true);
      assert.equal(pkg.scripts, undefined);
      assert.equal(pkg.dependencies, undefined);
      assert.equal(pkg.devDependencies, undefined);

      const binEntry = entries.get(`package/${platform.exe}`);
      assert.ok(binEntry, `${platform.pkg} missing ${platform.exe}`);
      if (process.platform !== 'win32') {
        assert.ok((binEntry.mode & 0o111) !== 0, `${platform.pkg} binary should be executable`);
      }
      assert.ok(entries.has('package/LICENSE'), `${platform.pkg} missing LICENSE`);
      const readme = entries.get('package/README.md')?.content.toString('utf8') ?? '';
      assert.match(readme, /@cloudflare\/forge/);
    }

    // Inspect main tarball.
    const mainTgz = tarball(out, version);
    assert.ok(existsSync(mainTgz));
    const mainEntries = readTarball(mainTgz);
    const mainPkg = JSON.parse(mainEntries.get('package/package.json').content.toString('utf8'));
    assert.equal(mainPkg.name, '@cloudflare/forge');
    assert.equal(mainPkg.version, version);
    assert.equal(mainPkg.scripts, undefined);
    assert.equal(mainPkg.devDependencies, undefined);
    assert.ok(!mainPkg.files.includes('native'), 'main package should not list native in files');
    assert.deepEqual(
      mainPkg.optionalDependencies,
      Object.fromEntries(platforms.map((platform) => [platform.pkg, version])),
    );
    assert.ok(mainEntries.has('package/bin/forge.cjs'));
    assert.ok(mainEntries.has('package/plugin/index.js'));
    assert.ok(mainEntries.has('package/LICENSE'));
    assert.ok(mainEntries.has('package/README.md'));
    for (const key of mainEntries.keys()) {
      assert.ok(!key.startsWith('package/native/'), `unexpected native entry in main tarball: ${key}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archive --platform restricts which platform tarballs get built', () => {
  const version = checkVersion();
  const root = mkdtempSync(join(tmpdir(), 'forge-archive-subset-'));
  try {
    const artifacts = join(root, 'binaries');
    const out = join(root, 'dist');
    const target = platforms[0];
    createStubArtifacts(artifacts, version, [target]);

    const packed = archive(artifacts, [target.id], out);
    assert.equal(packed.length, 2);
    assert.ok(existsSync(platformTarball(out, version, target)));
    assert.ok(existsSync(tarball(out, version)));
    for (const other of platforms.slice(1)) {
      assert.ok(!existsSync(platformTarball(out, version, other)));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archive --bundled produces a single tarball with native/ binaries and no optionalDependencies', () => {
  const version = checkVersion();
  const root = mkdtempSync(join(tmpdir(), 'forge-archive-bundled-'));
  try {
    const artifacts = join(root, 'binaries');
    const out = join(root, 'dist');
    const subset = [platforms[0]];
    createStubArtifacts(artifacts, version, subset);

    const packed = archive(artifacts, [subset[0].id], out, { bundled: true });
    assert.equal(packed.length, 1);
    const dest = tarball(out, version, [subset[0].id]);
    assert.equal(packed[0], dest);

    const entries = readTarball(dest);
    const pkg = JSON.parse(entries.get('package/package.json').content.toString('utf8'));
    assert.equal(pkg.optionalDependencies, undefined);
    assert.ok(pkg.files.includes('native'));
    assert.ok(entries.has(`package/native/${subset[0].id}/${subset[0].exe}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'npm install --ignore-scripts downloads only the matching platform package and records all platforms in lockfile',
  { skip: process.platform === 'win32' },
  async () => {
    const version = checkVersion();
    const currentId = `${process.platform}-${process.arch}`;
    const currentPlatform = platforms.find((p) => p.id === currentId);
    if (!currentPlatform) {
      return;
    }

    const root = mkdtempSync(join(tmpdir(), 'forge-npm-install-'));
    let server;
    try {
      const artifacts = join(root, 'binaries');
      const dist = join(root, 'dist');
      createStubArtifacts(artifacts, version);
      archive(artifacts, undefined, dist);

      // Build in-memory metadata for all 7 tarballs served over a local HTTP registry.
      const tgzByPkg = new Map([
        ['@cloudflare/forge', tarball(dist, version)],
        ...platforms.map((p) => [p.pkg, platformTarball(dist, version, p)]),
      ]);
      const tarballs = new Map();
      const manifests = new Map();
      for (const [pkgName, tgzPath] of tgzByPkg) {
        const bytes = readFileSync(tgzPath);
        const manifest = JSON.parse(readTarball(tgzPath).get('package/package.json').content.toString('utf8'));
        const fileName = `${pkgName.replace('/', '-')}-${version}.tgz`;
        const shasum = createHash('sha1').update(bytes).digest('hex');
        const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
        tarballs.set(`/${fileName}`, bytes);
        manifests.set(pkgName, { manifest, fileName, shasum, integrity });
      }

      server = createServer((req, res) => {
        const url = req.url ?? '/';
        if (tarballs.has(url)) {
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          res.end(tarballs.get(url));
          return;
        }
        const pkgName = decodeURIComponent(url.slice(1));
        const info = manifests.get(pkgName);
        if (!info) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }
        const { port } = server.address();
        const body = {
          name: pkgName,
          'dist-tags': { latest: version },
          versions: {
            [version]: {
              ...info.manifest,
              dist: {
                tarball: `http://127.0.0.1:${port}/${info.fileName}`,
                shasum: info.shasum,
                integrity: info.integrity,
              },
            },
          },
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      const registry = `http://127.0.0.1:${port}`;
      const emptyNpmrc = join(root, 'empty.npmrc');
      writeFileSync(emptyNpmrc, '');

      const npmEnv = {
        ...process.env,
        npm_config_userconfig: emptyNpmrc,
        npm_config_cache: join(root, 'npm-cache'),
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_update_notifier: 'false',
      };
      delete npmEnv.FORGE_BINARY;

      // 1. Standard install with --ignore-scripts: installs only current platform package.
      const projectDir = join(root, 'consumer');
      mkdirSync(projectDir);
      writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'consumer', private: true }));

      await execFileAsync(
        npm,
        [
          'install',
          '--ignore-scripts',
          `--registry=${registry}`,
          `--@cloudflare:registry=${registry}`,
          `@cloudflare/forge@${version}`,
        ],
        { cwd: projectDir, env: npmEnv, shell: npm.endsWith('.cmd') },
      );

      const installedScope = readdirSync(join(projectDir, 'node_modules', '@cloudflare')).sort();
      assert.deepEqual(installedScope, ['forge', `forge-${currentId}`]);

      // Cross-platform lockfile records all 6 optional platform packages.
      const lockfile = JSON.parse(readFileSync(join(projectDir, 'package-lock.json'), 'utf8'));
      for (const platform of platforms) {
        const key = `node_modules/${platform.pkg}`;
        assert.ok(lockfile.packages[key], `lockfile missing ${key}`);
        assert.equal(lockfile.packages[key].optional, true);
      }

      // Running the installed binary works with --ignore-scripts.
      const binRes = spawnSync(join(projectDir, 'node_modules', '.bin', 'forge'), ['--version'], {
        cwd: projectDir,
        env: npmEnv,
        encoding: 'utf8',
      });
      assert.equal(binRes.status, 0, binRes.stderr);
      assert.equal(binRes.stdout.trim(), `forge ${version} ${currentId}`);

      // 2. Installing with --omit=optional yields a clear error naming the missing platform package.
      const noOptDir = join(root, 'consumer-no-opt');
      mkdirSync(noOptDir);
      writeFileSync(join(noOptDir, 'package.json'), JSON.stringify({ name: 'consumer-no-opt', private: true }));
      await execFileAsync(
        npm,
        [
          'install',
          '--ignore-scripts',
          '--omit=optional',
          `--registry=${registry}`,
          `--@cloudflare:registry=${registry}`,
          `@cloudflare/forge@${version}`,
        ],
        { cwd: noOptDir, env: npmEnv, shell: npm.endsWith('.cmd') },
      );
      const errRes = spawnSync(join(noOptDir, 'node_modules', '.bin', 'forge'), ['--version'], {
        cwd: noOptDir,
        env: npmEnv,
        encoding: 'utf8',
      });
      assert.notEqual(errRes.status, 0);
      assert.match(errRes.stderr, new RegExp(currentPlatform.pkg.replace('/', '\\/')));
      assert.match(errRes.stderr, /--omit=optional/);
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);
