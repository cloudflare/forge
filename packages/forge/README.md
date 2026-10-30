# @cloudflare/forge

Generates SDKs from OpenAPI documents.

```sh
npm install --save-dev @cloudflare/forge
npx forge openapi.json --target ts --out sdk
```

Or run it once without installing:

```sh
npx @cloudflare/forge openapi.json --target ts --out sdk
```

Pass `-` instead of a path to read the document from standard input. Run
`forge --help` for every option.

## Normalizing a document

`forge normalize` rewrites metadata extensions from other tools into Forge's
`x-forge-*` vocabulary. This command does not change which extensions Forge
reads; adopting the native vocabulary in the parser is a separate change.

```sh
# Print the document with its keys rewritten. Nothing is changed.
npx forge normalize openapi.json

# Rewrite the files in place.
npx forge normalize --write specs/*.json

# Rewrite only Fern compatibility keys. --from may be repeated.
npx forge normalize --write --from fern specs/*.json

# Keep the old keys beside the native ones, for what still reads them.
npx forge normalize --write --leave-old-extensions openapi.json

# Write nothing, and fail if anything would be rewritten: for a check in CI.
npx forge normalize --check specs/*.json

# Read from standard input and write to standard output.
cat openapi.json | npx forge normalize -
```

Without `--write` it changes nothing and prints one document to standard
output, so several files need `--write` or `--check`. A file with nothing to
rewrite is left as it is, a link is followed and stays a link, and a read-only
file is left as it is, with an error. `-v` says how many times each key was
rewritten. Documents have to be JSON: YAML is not supported yet.

By default every compatibility source is normalized. Use `--from cloudflare`,
`--from deprecated`, `--from fern`, or `--from stainless` to select only that
source; repeat `--from` to select more than one. For example,
`--from fern --from cloudflare` leaves Stainless extensions untouched.
`deprecated` is the migration path for old Forge keys after they are renamed;
it currently has no keys.

What is rewritten:

- A group path written as an array becomes the names joined by dots
  (`["a", "b"]` becomes `"a.b"`), unless a name has a dot in it.
- A skip for only some targets, written as a list, has no native form, since
  `x-forge-skip` is for every target: it is left as it is. A skip that is plainly
  true or false is rewritten.
- Native keys always win: when a document says the same thing twice, the native
  key is kept.

<details>
<summary>Known limitations</summary>

`forge normalize` reads a document as JSON and writes it again, so a file that
has a key to rewrite is not a minimal edit. The order of its keys is kept.

- **A key written twice** keeps only its last copy, with no error or warning.
- **Numbers** that do not fit in 64 bits are rounded (`100000000000000000001`
  becomes `1e+20`), a decimal of more than about 17 digits is shortened, and
  `1E5`, `0.10` and `-0` are written `100000.0`, `0.1` and `-0.0`.
- **Formatting** is the writer's: the indentation of the first indented line is
  used for the whole file, arrays and objects on one line are written on
  several, blank lines, spaces at the end of a line and anything before the
  first `{` are dropped, `\r\n` becomes `\n`, and escapes such as `\u00e9` and
  `\/` are written as the characters.
- **Errors**: JSON with comments, a byte order mark, and a document nested
  deeper than 128 levels are not read.
- **Memory**: a document is held in memory at about 6.5 times its size, one file
  at a time.

</details>

## Plugins

A plugin generates an SDK, or anything else, from the document: forge parses
it, and hands the plugin its groups, methods, models and types. Plugins are
WebAssembly components, so they run anywhere forge does, sandboxed: a plugin
reads nothing but the document, and its only output is the files it returns.

```sh
npx forge openapi.json --target wasm://plugin.wasm --out sdk
```

### Writing one in TypeScript

```sh
npm install --save-dev @cloudflare/forge @bytecodealliance/jco
```

`plugin.ts`:

```ts
import { definePlugin, type Type } from '@cloudflare/forge/plugin';

function ts(type: Type): string {
  switch (type.kind) {
    case 'scalar':
      return type.scalar === 'number' ? 'number' : type.scalar === 'boolean' ? 'boolean' : 'string';
    case 'array':
      return `${ts(type.elem)}[]`;
    case 'model':
      return type.model.name.pascal();
    default:
      return 'unknown';
  }
}

export const { generate, generateGroup } = definePlugin({
  // Called once, for the whole document.
  generate(forge) {
    return [{ path: 'README.md', content: `# API ${forge.version}\n` }];
  },

  // Called once for each group, in parallel.
  generateGroup(group) {
    const dir = group.path.map((name) => name.camel()).join('/');
    const lines = group.models.map((m) => `export type ${m.name.pascal()} = ${ts(m.type)};`);
    return [{ path: `${dir}/models.ts`, content: lines.join('\n') }];
  },
});
```

Build it, and run it:

```sh
npx forge-plugin build plugin.ts -o plugin.wasm
npx forge openapi.json --target wasm://plugin.wasm --out sdk
```

`@cloudflare/forge/plugin` is typed throughout. A type is a union you narrow
by `kind`, so a `never` check in a `switch` turns a kind you missed into a
compile error. The same group, method or model is always the same object,
so you can compare them with `===` and keep them in a `Map`.

Array types expose `minItems` and `maxItems`; an absent bound is
`undefined`, and an explicit zero is kept. A string with OpenAPI format
`uuid` is exposed as `scalar: 'uuid'` (`Scalar::Uuid` in Rust), so plugins
can handle it explicitly. Other unrecognized string formats remain
`scalar: 'string'`. Forge does not validate request values.

The plugin interface is `forge:plugin@0.3.0`. Rebuild plugins compiled
against `0.2.0` with the updated package before running them with this
version of Forge.

A plugin fails by throwing; forge stops and prints the message. Its files
go through the same checks as forge's own: a path must be relative, use `/`,
have no `.` or `..` parts, and no two files may share one.

Things to know:

- **Each group runs in an instance of its own.** `generateGroup` sees
  nothing that `generate` or another group kept in module state.
- **There is no Node.** Plugins have no `fs`, `process`, network or clock.
  Libraries in plain JavaScript bundle in and work.
- **QuickJS runs the plugin.** `forge-plugin build` compiles it in, for a
  plugin of about 2 MB that starts in about 0.1 s. QuickJS has no
  `TextEncoder`; give a file its content as a string, and the library
  encodes it.
- **jco** compiles the plugin. It is large, and only plugin authors need
  it, so it is an optional peer dependency you install yourself.

### Generating TypeScript

`@cloudflare/forge/ts` writes TypeScript files and works out their imports.
Print a line by calling the file, `` f`…` ``, with identifiers in it: it imports
each one from its module when it renders, with `import type` for types, and
gives clashing names aliases.

A `Module` is a file a line can import from: a generated file, by its path in
the output, or a package. An `Ident` is a name and the module that declares
it. Print them in a `File`, and it writes the imports:

```ts
import { file, ident, join, module } from '@cloudflare/forge/ts';

// Modules: a generated file, by its path in the output, and a package.
const models = module('pets/models.ts');
const zod = module('zod');

// Identifiers: a name and the module that declares it.
const pet = models.ident('Pet');
const owner = ident('Owner', models);
const z = zod.ident('z');
const instant = module('temporal').ident('Temporal.Instant');

const f = file('pets/client.ts');
const client = f.ident('Client'); // declared in this file, so not imported

f.doc('A client of pets.');
f`export interface ${client} {`;
f.indent(() => {
  f`get(id: string): Promise<${pet.ty()}>;`;
  f`owners(): Promise<${join(' | ', [owner.ty(), 'null'])}>;`;
  f`seen(): ${instant.ty()};`;
});
f`}`;
f();
// A name used as a value and as a type is imported once, as a value.
f`export const schema = ${z}.object({ pet: ${pet}.schema });`;
// An alias, and a name that clashes with one the file declares.
f`export type Herd = ${models.ident('Pet').ty().as('Animal')}[];`;
f('export type Rival = ', module('other/models.ts').ident('Client').ty(), ';');
```

`f.content` is then:

```ts
// Code generated by forge. DO NOT EDIT.
/* eslint-disable */

import type { Temporal } from 'temporal';
import { z } from 'zod';

import type { Client as Client$ } from '../other/models.js';
import { type Owner, Pet, type Pet as Animal } from './models.js';

/**
 * A client of pets.
 */
export interface Client {
  get(id: string): Promise<Pet>;
  owners(): Promise<Owner | null>;
  seen(): Temporal.Instant;
}

export const schema = z.object({ pet: Pet.schema });
export type Herd = Animal[];
export type Rival = Client$;
```

Packages come first, then generated files, each imported by a path relative
to the file. `Client`, which the file declares, isn't imported, so the other
`Client` gets a `$`. `Pet` is used as both a type and a value, so it's
imported once, as a value; `Temporal.Instant` is imported as `Temporal`.

A plugin puts these together. This one writes a `models.ts` for each group,
importing the models it refers to from the groups they're in:

```ts
import { definePlugin, type Model, type Type } from '@cloudflare/forge/plugin';
import { type File, type Module, type Part, file, frag, ident, join, module } from '@cloudflare/forge/ts';

function ts(type: Type): Part {
  switch (type.kind) {
    case 'array':
      return frag`Array<${ts(type.elem)}>`;
    case 'union':
      return join(' | ', type.members.map(ts));
    case 'model':
      // Imported from the models.ts of the model's group.
      return frag`${ident.model(type.model).ty()}`;
    default:
      return frag`unknown`;
  }
}

/** The models.ts in `dir`, declaring `models`. */
function models(dir: Module, models: readonly Model[]): File {
  const f = file(dir.sub('models.ts'));
  for (const model of models) {
    f.doc(model.description);
    f`export type ${ident.model(model).name} = ${ts(model.type)};`;
  }
  return f;
}

export const { generate, generateGroup } = definePlugin({
  // The models in no group, which more than one top-level group uses.
  generate: (forge) => [models(module.ROOT, forge.models)],
  generateGroup: (group) => [models(module.group(group), group.models)],
});
```

- `` f`…` `` prints a line at the file's indentation. `f(...parts)` prints
  one of parts made at run time, and `f()` a blank one. `f.indent(() => …)`
  indents what it prints, and `f.doc(text)` prints a JSDoc comment, wrapped
  at 80 columns.
- A line's parts are strings, numbers, booleans, identifiers, models, which
  print as `ident.model`, and arrays of parts, which print each part in
  turn, with nothing between them. `join(sep, parts)` puts a separator
  between parts, and `` frag`…` `` makes part of a line to print later;
  both return an array of parts. Anything else, such as `undefined`, throws
  rather than printing `undefined`.
- `module("pets/models.ts")` is a generated file, which other files import
  as `./models.js`, and `module("zod")` a package. `m.ident(name)`, or
  `ident(name, m)`, is an identifier it declares; `.ty()` marks it as a
  type, and `.as(alias)` imports it under another name. `module.group(group)`
  is a group's directory, `module.ROOT` the output directory's, and
  `ident.model(model)` a model's identifier.
- `file(path)` returns a `File`, which is a plugin's file as it is: one with
  nothing printed isn't written, and its text starts with a preamble marking
  it as generated.
- `File`, `Module` and `Ident` are types, and only `file`, `module` and
  `ident` make them: they're immutable, and an object that merely has the
  same properties isn't one.

This is forge's own TypeScript printer, `forge::ts` in Rust, and prints the
same text.

### Writing one in another language

A plugin is a component of the `plugin` world in the WIT that
`npx forge-plugin wit` prints, which is also at
`@cloudflare/forge/plugin/forge.wit`. Any language with component tooling
works: in Rust, `wit_bindgen::generate!` and
`cargo build --target wasm32-wasip2`.

## Platforms

forge is a native binary, and this package carries one for each of:

- macOS, Apple silicon and Intel
- Linux, arm64 and x64
- Windows, arm64 and x64

The `forge` command is a small Node launcher that runs the right one. The
Linux binaries are statically linked, so they run on both glibc and musl
distributions, Alpine included. The Windows ones don't need the Visual C++
Redistributable.

To run some other forge binary through this package, such as a local build,
set `FORGE_BINARY` to its path.

## Installing from a tarball

The package is a single tarball, so you can install it without the
registry. Install it by path:

```sh
npm install --save-dev /path/to/cloudflare-forge-0.1.0.tgz
```

or list it in `package.json`. A path or URL to the tarball both work:

```json
"devDependencies": {
  "@cloudflare/forge": "file:../cloudflare-forge-0.1.0.tgz"
}
```

## Releasing

From the root of the forge repository, with [just](https://just.systems) installed:

```sh
pnpm install                            # the dev dependencies, which build the plugin library
node packages/forge/scripts/version.mjs # after bumping the version in Cargo.toml
node packages/forge/scripts/wit.mjs     # after changing the WIT in src/plugin/wasm.rs
just build-all                          # builds all six binaries into target/binaries/ (or: just fetch <run-id>)
just pack                               # packs them into packages/forge/dist/cloudflare-forge-<version>.tgz
```

To vendor the package in another repository, copy the tarball from
`packages/forge/dist/` and depend on it with a `file:` specifier.

The tarball that `just pack` makes is the one that gets published, so a
tarball you hand around and the package on the registry are the same.
`npm pack` and `npm publish` refuse to run in this directory, which has no
binaries of its own.

The binaries are built with the `wasm` feature, which runs plugins. The
package carries forge's copy of the WIT in `plugin/forge.wit`, and
`archive.mjs` refuses to pack it if it isn't the WIT in
`src/plugin/wasm.rs`.

The library plugins are written with, `@cloudflare/forge/plugin`, is
`src/index.ts`. `archive.mjs` builds it into the package, and
`node scripts/build.mjs` builds it into `plugin/` to try it out: jco
generates the TypeScript bindings of `plugin/forge.wit` into `src/wit`, and
`tsc` compiles the library against them into `plugin/index.js` and
`plugin/index.d.ts`. So when the WIT changes in a way the library doesn't
follow, such as a new kind of type, a new scalar or a renamed field, the
library fails to compile, and the package can't be packed. Its exports are
interfaces and the classes behind them are private, so the bindings never
appear in `index.d.ts`.

`@cloudflare/forge/ts` is `src/ts.ts`, built the same way. It reads the
forge only through the library's types, so it needs no host, and `npm test`
runs its tests in Node: the tests of `forge::ts` in
`src/plugin/ts/tests.rs`, expecting the same text.

### Building the binaries

Every way of getting the binaries puts them in `target/binaries/<target>/release/`,
and `just pack` packs whatever is there:

| Recipe                       | Builds                                      | Needs                    |
| ---------------------------- | ------------------------------------------- | ------------------------ |
| `just build <target>`        | one target, with this machine's `cargo`     | a host that can build it |
| `just build-docker <target>` | a Linux (musl) or Windows (MSVC) target     | Docker                   |
| `just build-all`             | all six: macOS natively, the rest in Docker | a Mac and Docker         |
| `just fetch <run-id>`        | nothing; downloads a publish-preview run's  | the GitHub CLI, `gh`     |

macOS binaries build only on a Mac. On Linux, `just build-all` builds the
other four, and `just fetch` gets all six from CI. The Docker images are in
`docker/release.Dockerfile` and build with the Rust in `rust-toolchain.toml`;
on an Apple silicon Mac, the x64 Linux build runs emulated, so it's slow.

The images also trust any `.crt` files in `docker/certs/`, which is gitignored.

CI builds each target with `just build` on a runner that builds it natively,
in the publish-preview workflow, then packs them with `just pack`.

The Windows binaries link the C runtime statically (see the `justfile`), so
they don't need the Visual C++ Redistributable.

### Trying it out locally

`just pack` takes `--platform <os>-<cpu>`, repeated, to pack only some
platforms. For a package that runs on this machine:

```sh
just build aarch64-apple-darwin
just pack --platform darwin-arm64
```

A tarball that leaves platforms out lists the ones it has in its name, as in
`cloudflare-forge-0.1.0-darwin-arm64.tgz`, so it can't pass for the full package.
