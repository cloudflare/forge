// Packs @cloudflare/forge, with the forge binary for every platform, into a
// tarball. That tarball is the package: scripts/publish.mjs publishes it, and
// another package can install it straight from the file:
//
//     node scripts/archive.mjs [--artifacts <dir>] [--platform <os-cpu>]... [--out <dir>]
//
//     npm install /path/to/cloudflare-forge-0.1.0.tgz
//     # or, in package.json: "@cloudflare/forge": "file:../cloudflare-forge-0.1.0.tgz"
//
// The binaries come from <dir>, the crate's target directory unless you say
// otherwise (see findBinary in platforms.mjs); scripts/compile.mjs builds
// them all. Every platform needs one.
//
// --platform packs only the platforms it names, such as darwin-arm64, which
// is enough to try the package out locally; `cargo build --release
// --features wasm` builds the binary for this machine. The tarball's name
// then lists them, and scripts/publish.mjs won't publish it.
//
// It builds @cloudflare/forge/plugin into the package, as scripts/build.mjs
// does, which needs this directory's dev dependencies: pnpm install here.
//
// The tarball goes in dist/ unless --out says otherwise.

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  buildPlugin,
  checkVersion,
  checkWit,
  display,
  distDir,
  fail,
  findBinary,
  npmDir,
  platforms,
  readJson,
  repoDir,
  tarball,
} from './platforms.mjs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

try {
  const { values } = parseArgs({
    options: {
      artifacts: { type: 'string', default: join(repoDir, 'target') },
      platform: { type: 'string', multiple: true },
      out: { type: 'string', default: distDir },
    },
  });
  archive(values.artifacts, values.platform, resolve(values.out));
} catch (err) {
  fail(err);
}

/**
 * Packs the binaries in `artifacts` for the platforms in `only`, or for all
 * of them, into a tarball in `out`.
 */
function archive(artifacts, only, out) {
  const version = checkVersion();
  checkWit();

  const known = platforms.map((platform) => platform.id);
  const unknown = only?.filter((id) => !known.includes(id)) ?? [];
  if (unknown.length > 0) {
    throw new Error(`unknown platform ${unknown.join(', ')}; forge supports ${known.join(', ')}`);
  }

  const chosen = platforms.filter((platform) => !only || only.includes(platform.id));
  const found = chosen.map((platform) => ({ platform, bin: findBinary(artifacts, platform) }));
  const missing = found.filter(({ bin }) => !bin).map(({ platform }) => platform.id);
  if (missing.length > 0) {
    throw new Error(
      `no forge binary in ${artifacts} for ${missing.join(', ')}; ` +
        `run node scripts/compile.mjs${only ? '' : ', or pack only some platforms with --platform'}`,
    );
  }

  const stage = mkdtempSync(join(tmpdir(), 'forge-archive-'));
  try {
    mkdirSync(join(stage, 'bin'));
    for (const name of ['forge.cjs', 'forge-plugin.mjs']) {
      copyFileSync(join(npmDir, 'bin', name), join(stage, 'bin', name));
      chmodSync(join(stage, 'bin', name), 0o755);
    }
    // What plugins are built with: the WIT, and the library over it, built
    // afresh so that a stale build in plugin/ can't get in.
    mkdirSync(join(stage, 'plugin'));
    for (const name of ['forge.wit', 'bundle.config.mjs']) {
      copyFileSync(join(npmDir, 'plugin', name), join(stage, 'plugin', name));
    }
    buildPlugin(join(stage, 'plugin'));
    copyFileSync(join(npmDir, 'README.md'), join(stage, 'README.md'));
    for (const { platform, bin } of found) {
      const dest = join(stage, 'native', platform.id, platform.exe);
      mkdirSync(join(dest, '..'), { recursive: true });
      copyFileSync(bin, dest);
      chmodSync(dest, 0o755);
      console.log(`added ${platform.id} from ${display(bin)}`);
    }

    // The scripts and dev dependencies build the package; they have no use
    // inside it, and the prepack guard would stop npm from packing it.
    const pkg = readJson(join(npmDir, 'package.json'));
    delete pkg.scripts;
    delete pkg.devDependencies;
    writeFileSync(join(stage, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

    const [{ filename }] = JSON.parse(
      execFileSync(npm, ['pack', '--json', '--pack-destination', stage], {
        cwd: stage,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
        shell: npm.endsWith('.cmd'),
      }),
    );
    mkdirSync(out, { recursive: true });
    const dest = tarball(
      out,
      version,
      chosen.map((platform) => platform.id),
    );
    copyFileSync(join(stage, filename), dest);
    console.log(`packed ${pkg.name}@${version} into ${display(dest)}`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
