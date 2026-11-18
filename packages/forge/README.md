# @cloudflare/forge

Generates SDKs from OpenAPI documents.

```sh
npm install --save-dev @cloudflare/forge
npx forge generate openapi.json --target ts --out sdk
```

Or run it once without installing:

```sh
npx @cloudflare/forge generate openapi.json --target ts --out sdk
```

Pass `-` instead of a path to read the document from standard input. Run
`forge --help` for every option.

## Reading a document in JavaScript

`parse` reads an OpenAPI document with forge in the same process. It returns
the document's forge, with the groups, methods, models and types a plugin
reads and the same API as `@cloudflare/forge/plugin`. It runs forge compiled
to WebAssembly, so it needs no binary and no plugin.

```ts
import { readFile } from 'node:fs/promises';
import { parse } from '@cloudflare/forge';

const forge = parse(await readFile('openapi.json', 'utf8'));
for (const group of forge.groups) {
  for (const method of group.methods) {
    console.log(method.httpMethod, method.path, method.name.camel());
  }
}
```

Forge reads only its native `x-forge-*` extensions. To read a document
written with another tool's extensions, name the tool in `adapters`. `parse`
then reads those extensions as `forge normalize --from` rewrites them, and
leaves the document as it is.

```ts
const forge = parse(json, { adapters: ['fern'] });
```

The adapters are `cloudflare`, `fern` and `stainless`.
[Normalizing a document](#normalizing-a-document) lists what each rewrites.

`parse` throws when forge doesn't read the document, such as one that is not
OpenAPI 3.x, with the message the `forge` command prints.

Several documents can be parsed side by side, such as one per version of an
API; each is a forge of its own.

## Normalizing a document

`forge normalize` rewrites metadata extensions from other tools into Forge's
`x-forge-*` vocabulary. Forge reads that native vocabulary directly: vendor
extensions have no parser effect until they are normalized.

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
`--from fern`, or `--from stainless` to select only that source; repeat `--from`
to select more than one. For example,
`--from fern --from cloudflare` leaves Stainless extensions untouched.

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

## Inspecting a document

`forge inspect` prints what forge reads in a document, as JSON.
`forge inspect methods` prints its methods, as an array. Each method has the
group path and name forge gives it from `x-forge-group-name`,
`x-forge-method-name` and `operationId`, in kebab-case, so a tool can compare
the methods of two versions of a document without naming them itself.

```sh
npx forge inspect methods openapi.json

# Other tools' extensions are read only once they are normalized.
npx forge normalize openapi.json | npx forge inspect methods -
```

```json
[
  {
    "group": ["dns", "records"],
    "name": "list",
    "method": "GET",
    "path": "/zones/{zone_id}/dns_records",
    "hidden": false,
    "deprecated": false,
    "availability": "generally-available"
  }
]
```

Methods come in the order of their groups, depth first from the root, and by
name within a group. `availability` is `null` when the operation does not say.
A document forge cannot read, such as one with two methods of the same name in
a group, is an error, as it is for generating an SDK.

## Plugins

A plugin generates an SDK, or anything else, from the document: forge parses
it, and hands the plugin its groups, methods, models and types. Plugins are
WebAssembly components, so they run anywhere forge does, sandboxed: a plugin
reads nothing but the document, and its only output is the files it returns.

```sh
npx forge generate openapi.json --target wasm://plugin.wasm --out sdk
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

export const { generate } = definePlugin({
  // Called once, for the whole document.
  generate(forge) {
    const files = [{ path: 'README.md', content: `# API ${forge.version}\n` }];
    // A models.ts for each group, the root included. The root's path is
    // empty, so its models.ts is at the top of the output.
    for (const group of forge.groups) {
      const path = [...group.path.map((name) => name.camel()), 'models.ts'].join('/');
      const lines = group.models.map((m) => `export type ${m.name.pascal()} = ${ts(m.type)};`);
      files.push({ path, content: lines.join('\n') });
    }
    return files;
  },
});
```

Build it, and run it:

```sh
npx forge-plugin build plugin.ts -o plugin.wasm
npx forge generate openapi.json --target wasm://plugin.wasm --out sdk
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

Every forge has a root group, which every other group is inside, and which
`forge.groups` has first. It is the only group with an empty name and path,
and the only one without a `parent`: a top-level group's `parent` is the
root. The root holds the methods whose operations have no
`x-forge-group-name`, and the models that methods in more than one top-level
group use, so every model has a `group`.

The plugin interface is `forge:plugin@0.5.0`. Rebuild plugins compiled
against `0.4.0` with the updated package before running them with this
version of Forge.

A plugin fails by throwing; forge stops and prints the message. Its files
go through the same checks as forge's own: a path must be relative, use `/`,
have no `.` or `..` parts, and no two files may share one.

Things to know:

- **A plugin runs once, on one thread.** forge calls `generate` once, in a
  fresh instance, and doesn't split the work across groups: forge's own
  generators run groups in parallel, but a plugin can't.
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

export const { generate } = definePlugin({
  // The root's directory is module.ROOT.
  generate: (forge) => forge.groups.map((group) => models(module.group(group), group.models)),
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
  is a group's directory, `module.ROOT` the output directory's and the root
  group's, and
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

forge is a native binary, distributed as per-platform npm packages via `optionalDependencies` (`@cloudflare/forge-<os>-<cpu>`):

- macOS, Apple silicon and Intel (`@cloudflare/forge-darwin-arm64`, `@cloudflare/forge-darwin-x64`)
- Linux, arm64 and x64 (`@cloudflare/forge-linux-arm64`, `@cloudflare/forge-linux-x64`)
- Windows, arm64 and x64 (`@cloudflare/forge-win32-arm64`, `@cloudflare/forge-win32-x64`)

The `forge` command is a small Node launcher that resolves the matching platform package at runtime without any `preinstall` or `postinstall` scripts, so installs work with `--ignore-scripts`. Linux binaries are statically linked (musl), so they run on both glibc and musl distributions, Alpine included. The Windows ones don't need the Visual C++ Redistributable.

To run some other forge binary through this package, such as a local build, set `FORGE_BINARY` to its path.

## Installing from a tarball

To install without the registry, pack a single bundled tarball with `just pack --bundled` (or `just pack --bundled --platform <os>-<cpu>` for one target). Install it by path:

```sh
npm install --save-dev /path/to/cloudflare-forge-0.2.0.tgz
```

or list it in `package.json`. A path or URL to the tarball both work:

```json
"devDependencies": {
  "@cloudflare/forge": "file:../cloudflare-forge-0.2.0.tgz"
}
```

## Releasing

To cut a release to npmjs.com:

1. Land a PR to `main` that bumps `Cargo.toml` `version` and syncs it with `node packages/forge/scripts/version.mjs`.
2. After it merges, create and push a signed tag:

```sh
git tag -s forge@0.2.0 -m 'forge 0.2.0'
git push origin forge@0.2.0
```

`.github/workflows/publish-forge.yml` builds all six binaries, packs the six `@cloudflare/forge-<os>-<cpu>` packages and `@cloudflare/forge`, and publishes the platform packages first followed by `@cloudflare/forge` to npmjs.com with provenance.

To build and pack locally from the root of the forge repository, with [just](https://just.systems) installed:

```sh
pnpm install                            # the dev dependencies, which build the plugin library
node packages/forge/scripts/version.mjs # after bumping the version in Cargo.toml
node packages/forge/scripts/wit.mjs     # after changing src/wasm/forge.wit
just build-all                          # builds all six binaries into target/binaries/ (or: just fetch <run-id>)
just pack                               # packs six platform tarballs + @cloudflare/forge into packages/forge/dist/
```

The seven tarballs that `just pack` makes are the ones published to npm (`cloudflare-forge-<os>-<cpu>-<version>.tgz` plus `cloudflare-forge-<version>.tgz`). To vendor a single self-contained tarball in another repository without the registry, run `just pack --bundled` and depend on `packages/forge/dist/cloudflare-forge-<version>.tgz` with a `file:` specifier. `npm pack` and `npm publish` refuse to run directly in this directory, which has no binaries of its own.

The binaries are built with the `wasm` feature, which runs plugins. The
package carries forge's copy of the WIT in `plugin/forge.wit`, and
`archive.mjs` refuses to pack it if it isn't `src/wasm/forge.wit`.

The library plugins are written with, `@cloudflare/forge/plugin`, is
`src/plugin.ts`, over the API in `src/forge.ts`. `archive.mjs` builds it into
the package, and `node scripts/build.mjs` builds it into `plugin/` to try it
out: jco generates the TypeScript bindings of `plugin/forge.wit` into
`src/wit`, and `tsc` compiles the library against them into `plugin/`. So
when the WIT changes in a way the library doesn't follow, such as a new kind
of type, a new scalar or a renamed field, the library fails to compile, and
the package can't be packed. Its exports are interfaces and the classes
behind them are private, so the bindings never appear in its declarations.

`parse`, the package's main export, is `src/index.ts`, over the same API.
It reads forge's `library` world, which the crate in `library/` exports.
`build.mjs` compiles the crate with cargo for `wasm32-unknown-unknown`, the
target `rust-toolchain.toml` installs, makes it a component with `jco new`,
and turns the component into JavaScript in `plugin/component` with
`jco transpile`. The plugin host and the library write a forge's parts as the
WIT's records with the same code, in `src/plugin/records.rs`.

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
then packs them with `just pack` for npm releases or `just pack --bundled` for
`pkg.pr.new` previews.

The Windows binaries link the C runtime statically (see the `justfile`), so
they don't need the Visual C++ Redistributable.

### Trying it out locally

`just pack` takes `--platform <os>-<cpu>`, repeated, to pack only some platforms. Combine with `--bundled` for a single self-contained tarball that runs on this machine without the registry:

```sh
just build aarch64-apple-darwin
just pack --bundled --platform darwin-arm64
```

A bundled tarball that leaves platforms out lists the ones it has in its name, as in `cloudflare-forge-0.2.0-darwin-arm64.tgz`, so it can't pass for the full package.
