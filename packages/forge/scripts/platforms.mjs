// What the release scripts share: the platforms forge ships for, and where
// things live.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The directory of the @cloudflare/forge package. */
export const npmDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The root of the Rust crate. */
export const repoDir = join(npmDir, '..', '..');

/** Where scripts/archive.mjs puts the tarball. */
export const distDir = join(npmDir, 'dist');

/**
 * The platforms forge ships for, each a binary in the package at
 * native/<os>-<cpu>/. `os` and `cpu` take the values of Node's
 * process.platform and process.arch, which the launcher looks the binary up
 * by, and `target` is the Rust target that builds it.
 *
 * `just build <target>` builds one (see the justfile); the publish-preview
 * workflow's build matrix and the justfile's target lists must name the same
 * platforms, and scripts/archive.mjs refuses to pack a package that misses one.
 *
 * Linux builds against musl so the binary is static and runs on any distro.
 */
export const platforms = [
  { os: 'darwin', cpu: 'arm64', target: 'aarch64-apple-darwin' },
  { os: 'darwin', cpu: 'x64', target: 'x86_64-apple-darwin' },
  { os: 'linux', cpu: 'arm64', target: 'aarch64-unknown-linux-musl' },
  { os: 'linux', cpu: 'x64', target: 'x86_64-unknown-linux-musl' },
  { os: 'win32', cpu: 'arm64', target: 'aarch64-pc-windows-msvc' },
  { os: 'win32', cpu: 'x64', target: 'x86_64-pc-windows-msvc' },
].map((platform) => ({
  ...platform,
  id: `${platform.os}-${platform.cpu}`,
  exe: platform.os === 'win32' ? 'forge.exe' : 'forge',
}));

/**
 * Returns the path to the forge binary for `platform` in `artifacts`, or
 * undefined if there is none. The binary is at <artifacts>/<target>/release/forge,
 * where `cargo build --release --target <target>` puts it, or at
 * <artifacts>/<target>/forge. The binary for this machine can also be at
 * <artifacts>/release/forge, where plain `cargo build --release` puts it.
 * When there are several, the newest wins.
 */
export function findBinary(artifacts, platform) {
  const paths = [
    join(artifacts, platform.target, 'release', platform.exe),
    join(artifacts, platform.target, platform.exe),
  ];
  if (platform.os === process.platform && platform.cpu === process.arch) {
    paths.push(join(artifacts, 'release', platform.exe));
  }
  return paths.filter((path) => existsSync(path)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

/** The package's copy of the WIT that wasm plugins are built against. */
export const witPath = join(npmDir, 'plugin', 'forge.wit');

/** Returns the WIT in src/wasm/forge.wit, which `forge::wasm::WIT` also holds. */
export function witSource() {
  return readFileSync(join(repoDir, 'src', 'wasm', 'forge.wit'), 'utf8');
}

/** Throws unless plugin/forge.wit is the WIT in src/wasm/forge.wit. */
export function checkWit() {
  let have;
  try {
    have = readFileSync(witPath, 'utf8');
  } catch {
    // Missing counts as stale.
  }
  if (have !== witSource()) {
    throw new Error(`${display(witPath)} is not the WIT in src/wasm/forge.wit; run node scripts/wit.mjs`);
  }
}

/**
 * Builds the package's libraries into `out`, plugin/ by default, and throws
 * if a step fails. It builds forge's library world with `buildComponent`,
 * generates the bindings of plugin/forge.wit's `plugin` world into src/wit,
 * and compiles src/index.ts, src/plugin.ts and src/ts.ts against both into
 * .js and .d.ts files in `out`.
 */
export function buildPlugin(out = join(npmDir, 'plugin')) {
  buildComponent(out);
  const bindings = join(npmDir, 'src', 'wit');
  rmSync(bindings, { recursive: true, force: true });
  node(devBin('@bytecodealliance/jco', 'jco'), [
    'guest-types',
    witPath,
    '--world-name',
    'plugin',
    '--quiet',
    '-o',
    bindings,
  ]);
  node(devBin('typescript', 'tsc'), ['-p', join(npmDir, 'tsconfig.json'), '--outDir', out]);
  console.log(`built @cloudflare/forge into ${display(out)}`);
}

/**
 * Builds forge's `library` world, which `parse` runs. It compiles library/,
 * a member of the root workspace, to WebAssembly with cargo, makes it a
 * component with jco, and turns the component into JavaScript in
 * <out>/component. It copies the component's types into src/component, for
 * the compiler.
 */
function buildComponent(out) {
  run('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'forge-library'], repoDir);
  const release = join(repoDir, 'target', 'wasm32-unknown-unknown', 'release');
  rmSync(join(out, 'component'), { recursive: true, force: true });
  rmSync(join(npmDir, 'src', 'component'), { recursive: true, force: true });
  cpSync(join(release, 'forge_library.wasm'), join(out, 'forge.wasm'));
  cpSync(join(npmDir, 'src', 'wasm-loader.js'), join(out, 'wasm-loader.js'));
}

/**
 * Returns the path to the command `name` of the dev dependency `pkg`, which
 * `pnpm install` in this directory installs.
 */
function devBin(pkg, name) {
  const dir = join(npmDir, 'node_modules', ...pkg.split('/'));
  let manifest;
  try {
    manifest = readJson(join(dir, 'package.json'));
  } catch {
    throw new Error(`${pkg} is not installed; run pnpm install in ${display(npmDir)}`);
  }
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[name];
  if (!bin) {
    throw new Error(`${pkg} has no command ${name}`);
  }
  return join(dir, bin);
}

/** Runs `command` with `args` in `cwd`, and throws if it fails. */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) {
    throw new Error(`cannot run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed in ${display(cwd)}`);
  }
}

/** Runs the Node script `script` with `args`, and throws if it fails. */
function node(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: npmDir, stdio: 'inherit' });
  if (result.error) {
    throw new Error(`cannot run ${script}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${display(script)} ${args.join(' ')} failed`);
  }
}

/** Reads the JSON file at `path`. */
export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Returns the version in Cargo.toml, which the package takes. */
export function cargoVersion() {
  const toml = readFileSync(join(repoDir, 'Cargo.toml'), 'utf8');
  const pkg = toml.match(/^\[package\]$([\s\S]*?)(?=^\[|(?![\s\S]))/m);
  const version = pkg?.[1].match(/^version\s*=\s*"([^"]+)"/m);
  if (!version) {
    throw new Error('cannot find the package version in Cargo.toml');
  }
  return version[1];
}

/**
 * Throws unless package.json has the version in Cargo.toml. Returns the
 * version.
 */
export function checkVersion() {
  const version = cargoVersion();
  const { version: have } = readJson(join(npmDir, 'package.json'));
  if (have !== version) {
    throw new Error(`package.json is at ${have} but Cargo.toml is at ${version}; run node scripts/version.mjs`);
  }
  return version;
}

/**
 * Returns the path of the tarball scripts/archive.mjs makes in `out` for
 * `version`, holding the binaries for `ids`. Only a tarball with every
 * platform goes without a suffix, so only that name can be published.
 */
export function tarball(out, version, ids = platforms.map((platform) => platform.id)) {
  const suffix = ids.length === platforms.length ? '' : `-${ids.join('-')}`;
  return join(out, `cloudflare-forge-${version}${suffix}.tgz`);
}

/** Returns `path` relative to the working directory if it's inside it. */
export function display(path) {
  const rel = relative(process.cwd(), path);
  return rel.startsWith('..') || isAbsolute(rel) ? path : rel;
}

/** Prints `err` and exits with failure. */
export function fail(err) {
  console.error(`error: ${err.message ?? err}`);
  process.exit(1);
}
