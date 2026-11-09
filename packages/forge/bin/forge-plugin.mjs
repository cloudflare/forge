#!/usr/bin/env node
// Builds forge plugins written in JavaScript or TypeScript.
//
//     forge-plugin build <entry> [-o plugin.wasm]
//     forge-plugin wit
//
// `build` bundles the entry module and its dependencies, and compiles them
// with QuickJS into a WebAssembly component that
// `forge --target wasm://plugin.wasm` runs. It uses jco, which projects
// install themselves, since it is large and only plugin authors need it:
//
//     npm install --save-dev @bytecodealliance/jco
//
// `wit` prints the WIT plugins are built against, for plugins in other
// languages.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin');
const wit = join(pluginDir, 'forge.wit');

const usage = `usage: forge-plugin build <entry> [-o plugin.wasm]
       forge-plugin wit

build   compiles the plugin whose entry module is <entry>, a .ts or .js file
        that exports definePlugin's generate and generateGroup, into a
        WebAssembly component with QuickJS. Run it with:
            forge openapi.json --target wasm://plugin.wasm --out sdk
        -o, --out      the component to write (default: plugin.wasm)
wit     prints the WIT plugins are built against`;

/** Prints `message` and exits with failure. */
function fail(message) {
  process.stderr.write(`forge-plugin: ${message}\n`);
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'build':
    build(rest);
    break;
  case 'wit':
    process.stdout.write(readFileSync(wit, 'utf8'));
    break;
  case '-h':
  case '--help':
  case 'help':
    console.log(usage);
    break;
  default:
    fail(command ? `unknown command ${command}\n${usage}` : usage);
}

function build(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        out: { type: 'string', short: 'o', default: 'plugin.wasm' },
      },
    });
  } catch (err) {
    fail(`${err.message}\n${usage}`);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) {
    fail(`build takes one entry module\n${usage}`);
  }
  const entry = resolve(positionals[0]);
  if (!existsSync(entry)) {
    fail(`${positionals[0]} does not exist`);
  }

  const jco = findJco(dirname(entry));
  const result = spawnSync(
    process.execPath,
    [
      jco,
      'componentize',
      entry,
      '--wit',
      wit,
      '--world-name',
      'plugin',
      '--bundle',
      '--bundle-config',
      join(pluginDir, 'bundle.config.mjs'),
      '--backend',
      'quickjs',
      // The host runs components without the async ABI.
      '--backend-qjs-disable-async',
      '--out',
      resolve(values.out),
    ],
    { stdio: 'inherit' },
  );
  if (result.error) {
    fail(`cannot run jco: ${result.error.message}`);
  }
  process.exitCode = result.status ?? 1;
}

/**
 * Returns the path to jco's command, installed in the project of `dir` or
 * beside this package.
 */
function findJco(dir) {
  for (const from of [dir, dirname(fileURLToPath(import.meta.url))]) {
    // jco's exports leave out its package.json, so its main module is
    // resolved, as Node would, and its package found above that.
    let main;
    try {
      main = createRequire(join(from, 'noop.js')).resolve('@bytecodealliance/jco');
    } catch {
      continue; // Not installed there.
    }
    for (let pkgDir = dirname(main); pkgDir !== dirname(pkgDir); pkgDir = dirname(pkgDir)) {
      const pkgPath = join(pkgDir, 'package.json');
      if (!existsSync(pkgPath)) {
        continue;
      }
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg.name !== '@bytecodealliance/jco') {
        continue;
      }
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.jco;
      if (bin) {
        return join(pkgDir, bin);
      }
    }
  }
  fail('building a plugin needs jco; run npm install --save-dev @bytecodealliance/jco');
}
