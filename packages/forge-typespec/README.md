# @cloudflare/forge-typespec

Read OpenAPI specs written in TypeSpec into Forge.

`@cloudflare/forge-typespec` is an OpenAPI loader for `@cloudflare/forge`. A spec
written in TypeSpec loads into the same OpenAPI 3.0 document that `tsp compile`
writes for it, byte for byte, so Forge treats it exactly as it treats that
document written in JSON or YAML.

## Package roles

| Package                      | Responsibility                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `@cloudflare/forge`          | The OpenAPI loader registry, the JSON and YAML loaders, overlays, and code generation             |
| `@cloudflare/forge-typespec` | The loader that compiles TypeSpec specs to OpenAPI documents                                      |
| The spec's project           | The TypeSpec compiler, `@typespec/openapi3`, the libraries the spec imports, and `tspconfig.yaml` |

## Load a spec

Register the loaders for the formats you accept, then load a source. Pass the
document to `init` as you would any OpenAPI document.

```ts
import { createOpenApiLoaders, init, jsonLoader, yamlLoader } from '@cloudflare/forge';
import { typeSpecLoader } from '@cloudflare/forge-typespec';

const loaders = createOpenApiLoaders(jsonLoader(), yamlLoader(), typeSpecLoader());

const document = await loaders.loadOne({ format: 'typespec', entry: 'spec' });
const forge = await init(document);
```

`entry` is a `.tsp` file or a TypeSpec project directory, as a path or a `file:`
URL object. A directory resolves its entry file the way `tsp compile` does: the
`entrypoint` in its `tspconfig.yaml`, then its `package.json`, then `main.tsp`.

## Choose a service or version

A spec can define several services, and a `@versioned` service has one document
per version. `load` returns every document, named by its service namespace and,
for a versioned service, its version: `Billing@v1`, `Billing@v2`, `Identity`.
A spec without `@service` has one document, named by the placeholder title the
OpenAPI emitter gives it, `(title)`.

`loadOne` needs exactly one document, so narrow the source with `service` and
`version` first. `version` is the value of the version enum member.

```ts
await loaders.loadOne({ format: 'typespec', entry: 'spec', service: 'Billing', version: 'v2' });
```

## Add Forge metadata

Forge reads its own metadata, such as `x-fern-sdk-group-name` and
`x-forge-commands`, from the OpenAPI document. The loader adds none. Supply it as
you would for a JSON or YAML spec:

- **Overlays.** Pass API overlays to `init(document, overlays)`. They match
  operations by `operationId`, which under the default `operation-id-strategy`
  TypeSpec derives from the interface and operation names, for example
  `Accounts_list`.
- **Extensions in the spec.** Declare the fields with `@extension` from
  `@typespec/openapi`: on operations for per-operation fields, and on the
  service namespace for document-level fields such as `x-forge-commands`:

```tsp
import "@typespec/http";
import "@typespec/openapi";

using Http;
using OpenAPI;

@service(#{ title: "Accounts" })
@extension("x-forge-commands", #{ accounts: #{ description: "Manage accounts." } })
namespace Accounts;

model Account {
  id: string;
}

@route("/accounts")
interface Accounts {
  /** List accounts. */
  @extension("x-fern-sdk-group-name", "accounts")
  @extension("x-fern-sdk-method-name", "list")
  @get
  list(): Account[];
}
```

## Handle warnings

Compiler warnings do not fail a load. Each is passed to `onWarning` as
`tsp compile --pretty=false` prints it, with paths relative to the working
directory, and printed with `console.warn` by default:

```ts
const loader = typeSpecLoader({ onWarning: (message) => logger.warn(message) });
```

## Compilation reference

- The TypeSpec compiler is imported from the spec's project, the one `compile()`
  expects: it reports `compiler-version-mismatch` when a different version runs.
  The compiler this package depends on is used only when the project has none.
- `@typespec/openapi3` is loaded by that compiler from the spec's project, so it
  must be installed there. The project needs TypeSpec 1.15 or later.
- The project's `tspconfig.yaml` applies as it does for `tsp compile` without
  `--config`. That covers linter rules, `warn-as-error`, `#suppress` and the
  `@typespec/openapi3` options, which are validated as the emitter defines them.
- For a directory entry, the config is looked up from that directory.
  `tsp compile <dir>` resolves the entry file first and looks the config up from
  the file's directory, so when the entry file sits in a subdirectory with its
  own `tspconfig.yaml`, pass the entry file.
- Only the OpenAPI emitter runs, once, writing its files to memory. Other
  emitters listed in `tspconfig.yaml` do not run, and nothing is written to disk.
- Documents are always OpenAPI 3.0.0, the version Forge's resolver reads. This
  overrides `openapi-versions`, and can raise the emitter's warnings about
  options that need OpenAPI 3.1, such as `enum-strategy: annotated`. Under
  `warn-as-error`, those fail the load.
- Errors fail the load, listing each diagnostic, with its file, line and column
  when it has a location.
- TypeSpec keeps state for the life of a process, and `tsp` compiles one project
  per process. JavaScript decorator libraries a spec imports load once, so edits
  to them need a new process. Every TypeSpec library copy loaded is recorded, so
  after specs from projects on different TypeSpec versions have loaded, another
  can fail with `incompatible-library`; load those in separate processes.

## Public API

All public exports are available from `@cloudflare/forge-typespec`:

| Export                  | Kind     | Use                                                             |
| ----------------------- | -------- | --------------------------------------------------------------- |
| `typeSpecLoader()`      | Function | Create the OpenAPI loader for the `typespec` format             |
| `TypeSpecLoaderOptions` | Type     | Options for the loader: `onWarning`                             |
| `TypeSpecOpenApiSource` | Type     | Source accepted by the loader: `entry`, `service` and `version` |
