#!/usr/bin/env node
// Runs the forge binary for this platform. Standard npm installs resolve the
// matching @cloudflare/forge-<os>-<cpu> optionalDependency without any
// preinstall/postinstall scripts; bundled preview/local tarballs fall back to
// native/<os>-<cpu>/forge.

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const exe = process.platform === 'win32' ? 'forge.exe' : 'forge';

/** Prints `message` and exits with failure. */
function fail(message) {
  process.stderr.write(`forge: ${message}\n`);
  process.exit(1);
}

/** Returns the path to the forge binary for this platform. */
function binary() {
  // Lets you run a local build, such as target/debug/forge, through npm.
  if (process.env.FORGE_BINARY) {
    return process.env.FORGE_BINARY;
  }

  const platform = `${process.platform}-${process.arch}`;
  const pkg = `@cloudflare/forge-${platform}`;

  try {
    return require.resolve(`${pkg}/${exe}`);
  } catch (err) {
    if (err && err.code !== 'MODULE_NOT_FOUND') {
      throw err;
    }
  }

  // Bundled tarballs (pkg.pr.new previews and `just pack --bundled`) carry
  // binaries under native/<os>-<cpu>/ instead of optionalDependencies.
  const native = path.join(__dirname, '..', 'native');
  const bundled = path.join(native, platform, exe);
  if (fs.existsSync(bundled)) {
    return bundled;
  }

  const bundledPlatforms = fs.existsSync(native) ? fs.readdirSync(native) : [];
  if (bundledPlatforms.length > 0) {
    fail(
      `could not find platform package ${pkg} for ${platform}, and this bundled package only has binaries for ${bundledPlatforms.join(', ')}`,
    );
  }

  fail(
    `could not find platform package ${pkg} for ${platform}. ` +
      `This usually happens if ${platform} is unsupported, if dependencies were installed with --no-optional or --omit=optional, ` +
      `or if node_modules was copied from another OS or CPU. ` +
      `Reinstall without omitting optional dependencies, or set FORGE_BINARY to a local forge binary.`,
  );
}

const bin = binary();
const result = spawnSync(bin, process.argv.slice(2), { stdio: 'inherit' });
if (result.error) {
  fail(`cannot run ${bin}: ${result.error.message}`);
}
if (result.signal) {
  // End this process the same way the binary ended.
  process.kill(process.pid, result.signal);
  // Reached only when the signal does not end the process; Node ignores
  // SIGPIPE, for one.
  process.exitCode = 128 + (os.constants.signals[result.signal] ?? 0);
} else {
  process.exitCode = result.status;
}
