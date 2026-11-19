// Packs @cloudflare/forge and its per-platform binary packages into tarballs.
//
//     node scripts/archive.mjs [--artifacts <dir>] [--platform <os-cpu>]... [--out <dir>] [--bundled]
//
// By default this produces seven tarballs:
//   - six per-platform packages (`cloudflare-forge-<os>-<cpu>-<version>.tgz`),
//     each holding only its binary, LICENSE, and a short README.md
//   - the main package (`cloudflare-forge-<version>.tgz`), holding bin/,
//     plugin/, README.md, and LICENSE, with optionalDependencies pinned to all
//     six platform packages at the version from Cargo.toml / package.json
//
// --platform restricts which platform tarballs get built, for local testing.
//
// --bundled instead packs one combined tarball with binaries under
// native/<os>-<cpu>/ and no optionalDependencies, for pkg.pr.new previews and
// single-file local installs (`npm install /path/to/cloudflare-forge-0.2.0.tgz`).
// When --platform is combined with --bundled, the tarball name lists the
// included platforms so it can't pass for the full package.
//
// The binaries come from <dir>, the crate's target directory unless you say
// otherwise (see findBinary in platforms.mjs). `just pack` runs this script on
// target/binaries, which `just build-all` fills, or `just fetch` from a CI run.
//
// It builds @cloudflare/forge/plugin into the main package, as scripts/build.mjs
// does, which needs this directory's dev dependencies: pnpm install here.
//
// Tarballs go in dist/ unless --out says otherwise.

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  platformTarball,
  readJson,
  repoDir,
  tarball,
} from './platforms.mjs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        artifacts: { type: 'string', default: join(repoDir, 'target') },
        platform: { type: 'string', multiple: true },
        out: { type: 'string', default: distDir },
        bundled: { type: 'boolean', default: false },
      },
    });
    archive(values.artifacts, values.platform, resolve(values.out), { bundled: values.bundled });
  } catch (err) {
    fail(err);
  }
}

/** Runs `npm pack` in `stage` and copies the produced tarball to `dest`. */
function packStage(stage, out, dest) {
  const [{ filename }] = JSON.parse(
    execFileSync(npm, ['pack', '--json', '--pack-destination', stage], {
      cwd: stage,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      shell: npm.endsWith('.cmd'),
    }),
  );
  mkdirSync(out, { recursive: true });
  copyFileSync(join(stage, filename), dest);
}

/** Stages and packs a single per-platform binary package into `out`. */
function packPlatform(platform, bin, version, mainPkg, out) {
  const stage = mkdtempSync(join(tmpdir(), `forge-archive-${platform.id}-`));
  try {
    const binDest = join(stage, platform.exe);
    copyFileSync(bin, binDest);
    chmodSync(binDest, 0o755);
    copyFileSync(join(repoDir, 'LICENSE'), join(stage, 'LICENSE'));
    writeFileSync(
      join(stage, 'README.md'),
      `# ${platform.pkg}\n\n` +
        `This is the \`${platform.id}\` binary package for [\`${mainPkg.name}\`](https://www.npmjs.com/package/${mainPkg.name}). ` +
        `Install \`${mainPkg.name}\` instead of installing this package directly.\n`,
    );

    const pkg = {
      name: platform.pkg,
      version,
      description: `Forge binary for ${platform.id}.`,
      homepage: mainPkg.homepage,
      bugs: mainPkg.bugs,
      license: mainPkg.license,
      author: mainPkg.author,
      repository: mainPkg.repository,
      os: [platform.os],
      cpu: [platform.cpu],
      files: [platform.exe],
      publishConfig: mainPkg.publishConfig,
      preferUnplugged: true,
    };
    writeFileSync(join(stage, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

    const dest = platformTarball(out, version, platform);
    packStage(stage, out, dest);
    console.log(`packed ${platform.pkg}@${version} from ${display(bin)} into ${display(dest)}`);
    return dest;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** Stages and packs the main @cloudflare/forge package into `out`. */
function packMain(version, mainPkg, out, { bundled, found }) {
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
    copyFileSync(join(repoDir, 'LICENSE'), join(stage, 'LICENSE'));

    // The scripts and dev dependencies build the package; they have no use
    // inside it, and the prepack guard would stop npm from packing it.
    const pkg = structuredClone(mainPkg);
    delete pkg.scripts;
    delete pkg.devDependencies;

    if (bundled) {
      for (const { platform, bin } of found) {
        const dest = join(stage, 'native', platform.id, platform.exe);
        mkdirSync(join(dest, '..'), { recursive: true });
        copyFileSync(bin, dest);
        chmodSync(dest, 0o755);
        console.log(`added ${platform.id} from ${display(bin)}`);
      }
      if (!pkg.files.includes('native')) {
        pkg.files = [...pkg.files, 'native'];
      }
      delete pkg.optionalDependencies;
    } else {
      pkg.files = pkg.files.filter((entry) => entry !== 'native');
      pkg.optionalDependencies = Object.fromEntries(platforms.map((platform) => [platform.pkg, version]));
    }

    writeFileSync(join(stage, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

    const dest = bundled
      ? tarball(
          out,
          version,
          found.map(({ platform }) => platform.id),
        )
      : tarball(out, version);
    packStage(stage, out, dest);
    console.log(`packed ${pkg.name}@${version} into ${display(dest)}`);
    return dest;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * Packs the binaries in `artifacts` for the platforms in `only`, or for all
 * of them, into tarballs in `out`.
 */
export function archive(artifacts, only, out, { bundled = false } = {}) {
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
        `build them with just build-all, or fetch a CI run's with just fetch <run-id>` +
        (only ? '' : ', or pack only some platforms with --platform'),
    );
  }

  const mainPkg = readJson(join(npmDir, 'package.json'));
  if (bundled) {
    return [packMain(version, mainPkg, out, { bundled: true, found })];
  }

  const packed = [];
  for (const { platform, bin } of found) {
    packed.push(packPlatform(platform, bin, version, mainPkg, out));
  }
  packed.push(packMain(version, mainPkg, out, { bundled: false, found }));
  return packed;
}
