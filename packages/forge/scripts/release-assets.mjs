// Builds the files attached to a Forge GitHub release from the same native
// binaries that scripts/archive.mjs packed into @cloudflare/forge.
//
//     node scripts/release-assets.mjs \
//       --artifacts ../../target/binaries \
//       --npm-archive dist/cloudflare-forge-0.1.0.tgz \
//       --tag v0.1.0

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { checkVersion, display, distDir, fail, findBinary, platforms, repoDir, tarball } from './platforms.mjs';

try {
  const version = checkVersion();
  const { values } = parseArgs({
    options: {
      artifacts: { type: 'string', default: join(repoDir, 'target', 'binaries') },
      'npm-archive': { type: 'string', default: tarball(distDir, version) },
      out: { type: 'string', default: join(distDir, 'release') },
      tag: { type: 'string' },
    },
  });
  releaseAssets(version, values.tag, resolve(values.artifacts), resolve(values['npm-archive']), resolve(values.out));
} catch (err) {
  fail(err);
}

function releaseAssets(version, tag, artifacts, npmArchive, out) {
  if (tag && tag !== `v${version}`) {
    throw new Error(`release tag ${tag} does not match Cargo and npm version ${version}`);
  }

  const found = platforms.map((platform) => ({ platform, bin: findBinary(artifacts, platform) }));
  const missing = found.filter(({ bin }) => !bin).map(({ platform }) => platform.id);
  if (missing.length > 0) {
    throw new Error(`no forge binary in ${artifacts} for ${missing.join(', ')}`);
  }
  // Read it before clearing the output directory, and fail early if `just pack`
  // did not produce the package from this matrix.
  readFileSync(npmArchive);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const assets = [];

  for (const { platform, bin } of found) {
    const name = `forge-${version}-${platform.id}`;
    const stage = mkdtempSync(join(tmpdir(), 'forge-release-'));
    try {
      const dir = join(stage, name);
      mkdirSync(dir);
      const executable = join(dir, platform.exe);
      copyFileSync(bin, executable);
      chmodSync(executable, 0o755);
      copyFileSync(join(repoDir, 'LICENSE'), join(dir, 'LICENSE'));

      const archive = join(out, `${name}.tar.gz`);
      execFileSync('tar', ['-czf', archive, '-C', stage, name]);
      assets.push(archive);
      console.log(`packed ${platform.id} from ${display(bin)} into ${display(archive)}`);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }

  const npmAsset = join(out, basename(npmArchive));
  copyFileSync(npmArchive, npmAsset);
  assets.push(npmAsset);

  const sums = assets
    .sort((a, b) => basename(a).localeCompare(basename(b)))
    .map((asset) => `${sha256(asset)}  ${basename(asset)}`)
    .join('\n');
  writeFileSync(join(out, 'SHA256SUMS'), `${sums}\n`);
  console.log(`wrote checksums and ${assets.length} release assets to ${display(out)}`);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
