# @cloudflare/redocly-plugin-forge

A [Redocly](https://redocly.com/docs/cli/) plugin that catches a dozen common OpenAPI mistakes on any spec: name collisions after case-folding, GET requests with bodies, schemas whose `default` doesn't match their declared type, boolean extensions with non-boolean values, invalid `required` keys, exploded form-data parameters that aren't arrays, multipart bodies composed with `allOf`, and more.

Twenty rules total. All are OAS-native (OpenAPI 2 and 3) except for a small set that additionally validate `x-forge-*` extensions used by [Cloudflare Forge](https://github.com/cloudflare/forge); those fast-path to no-ops on specs that don't use the extensions, so they're free to leave enabled.

Started life as a port of [`dimitropoulos/redocly-plugin-fern`](https://github.com/dimitropoulos/redocly-plugin-fern) with the Fern-specific gating removed. See [`FUTURE.md`](./FUTURE.md) for rules we've considered but not shipped yet.

## Install

```sh
pnpm add -D @cloudflare/redocly-plugin-forge
# or
npm install --save-dev @cloudflare/redocly-plugin-forge
```

Peer dependency: `@redocly/openapi-core` v2.

## Usage

```yaml
# redocly.yaml
plugins:
  - '@cloudflare/redocly-plugin-forge'

extends:
  - forge/recommended

rules:
  # Opt out of a single rule:
  forge/no-complex-query-params: off
```

The plugin exposes one config, `forge/recommended`: every plugin rule at its declared severity, plus the subset of built-in Redocly rules this plugin relies on. Every rule is named `forge/<rule-name>`.

### Identifier collisions

Four rules catch names that are distinct on the wire but normalize to the same SDK identifier after Forge's `Name::new` word-splitting (so `notification_url` collides with `notificationUrl`, `getBy` with `get_by`, and so on):

- `forge/no-conflicting-parameter-names` — within one operation, path+query+cookie and top-level JSON request-body properties share one namespace; headers share another (ignoring `Accept`, `Content-Type`, and `Authorization`). Body properties with `readOnly: true` or `x-forge-skip: true` are excluded, and `allOf`/`oneOf`/`anyOf` body schemas are out of scope. Also reports repeated path placeholders (`/pets/{id}/toys/{id}`) and placeholders with no letters or digits.
- `forge/no-conflicting-property-names` — properties on the same object schema. Skips `x-forge-skip: true`. `readOnly` and `writeOnly` properties are included, since both appear on at least one of the generated request / response types.
- `forge/no-conflicting-schema-names` — keys under `components.schemas`. Skips `x-forge-skip: true`.
- `forge/no-duplicate-method-name` — `(x-forge-group-name, x-forge-method-name)` pairs across operations and `x-forge-aliases`. An alias inherits its operation's group when it does not declare its own.

Each rule honors the matching `x-forge-*-name` override (`x-forge-parameter-name`, `x-forge-property-name`, `x-forge-model-name`, `x-forge-method-name`) and uses the overridden value for collision detection.

### `allOf` composition

Two rules split the two things an `allOf` wrapper can get wrong:

- `forge/compatible-allof-intersection` — reports `allOf` compositions whose members' types cannot all be satisfied by the same value. Traces `$ref` chains, intersects across `allOf`, unions across `oneOf`/`anyOf`, and infers `object` from `properties`/`additionalProperties` and `array` from `items`. `nullable: true` (OAS 3.0) and `type: [X, 'null']` (OAS 3.1) are treated as alternates, not additional constraints; `integer` composes with `number`. The deliberately permitted case is the OAS 3.0 sibling-escape idiom — a single-member `allOf: [{$ref}]` whose enclosing schema has only annotation siblings — since it is the only way OAS 3.0 lets you attach `description`/`example` to a `$ref`.
- `forge/no-redundant-allof-ref-wrapper` _(opt-in, `warn`)_ — flags that same sibling-escape wrapper on OAS 3.1 and 3.2, where `$ref` composes with siblings directly and the wrapper is unnecessary. Fires only when every non-`allOf` sibling on the enclosing schema is an annotation keyword (`description`, `title`, `example`, `default`, `deprecated`, `readOnly`, `writeOnly`, …); the inheritance idiom (`{properties, allOf: [{$ref: Base}]}`) is left alone. Enable in `rules:` to opt in.

## Using in CI

The plugin is designed to run in downstream lint pipelines against production OpenAPI specs. A few practical notes from running it against representative specs:

### Gradual severity ratchet

Adopt in three passes rather than flipping every rule to `error` on day one. Each pass raises severity only once the previous level is clean, so a broken build always points at something the author introduced, not at a backlog:

```yaml
# redocly.yaml — adoption step 1
extends:
  - forge/recommended

rules:
  # Cap the collision-class rules at info until the backlog is burned down,
  # so new conflicts still surface without blocking the build on legacy ones.
  forge/no-conflicting-parameter-names: info
  forge/no-conflicting-property-names: info
  forge/no-conflicting-schema-names: info
  forge/no-duplicate-method-name: info
```

Promote individual rules to `warn`, then `error`, as the backlog shrinks.

### Rules safe to adopt at `error` immediately

These have zero real-world hits in the representative specs we smoke-tested against, so enabling them at `error` costs no cleanup effort and guards against future regressions:

- `forge/valid-identifiers`
- `forge/valid-group-name`

### Rules worth capping at `info` or `warn`

Collision-class rules (`forge/no-conflicting-parameter-names`, `forge/no-conflicting-property-names`, `forge/no-conflicting-schema-names`, `forge/no-duplicate-method-name`) report every surface where a conflict appears, so one logical collision can produce several findings on a large spec. The signal is real but noisy; cap at `info` while the backlog is being burned down rather than disabling the rule outright, so new conflicts still surface.

### Overriding severities per rule

Redocly's standard `rules:` map accepts `off`, `info`, `warn`, `error`, or an object with `severity` for rules that take options:

```yaml
rules:
  forge/no-get-request-body: error # promote
  forge/boolean-extensions: warn # soften
  forge/valid-availability: off # disable
```

## Trust model

This plugin runs inside the Redocly CLI on CI runners that may hold deploy credentials. It is designed to be safe to run on untrusted specs:

**What it does.** Reads an OpenAPI document via the Redocly CLI's visitor API. Reports findings. That's the entire effect surface.

**What it does not do.**

- No network I/O. No `fetch`, no `http`, no DNS lookups. The plugin never contacts a remote server.
- No filesystem writes. The plugin never calls `fs.write*`, never creates or modifies files.
- No shell execution. The plugin never spawns subprocesses.
- No dynamic code evaluation. No `eval`, `new Function`, `vm.runInNewContext`, or dynamic `import()` of spec-derived paths.
- No regular expressions compiled from spec-controlled input. All regexes are literals in the plugin's source, so a hostile spec cannot drive ReDoS via a crafted pattern.

Future contributions must preserve these properties. A PR that introduces any of the above should be rejected unless it comes with a specific, bounded justification and the README is updated to match.

**What a consumer should audit before running the plugin on protected refs.** The package is published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) linking each release artifact to the commit and GitHub Actions workflow run that produced it. Before installing into any CI image:

- Pin an exact version in your lockfile (not a floating range).
- Verify provenance: `npm view @cloudflare/redocly-plugin-forge@<version> --json | jq .dist.attestations` (or inspect on npmjs.com).
- Run `pnpm audit --audit-level=high` (or `npm audit --audit-level=high`) on the lockfile that will install the plugin, and fail the build on any high-or-critical finding.
- Install with `--frozen-lockfile` so a transitive-dep tag swap cannot slip through.

## Development

```bash
pnpm --filter @cloudflare/redocly-plugin-forge typecheck
pnpm --filter @cloudflare/redocly-plugin-forge test

# Update fixture snapshots after an intentional change:
pnpm --filter @cloudflare/redocly-plugin-forge test:update

# Compile to dist/ for publish:
pnpm --filter @cloudflare/redocly-plugin-forge build
```

Tests use [Vitest](https://vitest.dev/). Fixtures live under `test/fixtures/<base-rule-name>/<case-name>/` with an `openapi.yaml` (or `.json` / `swagger.yaml`), an optional `redocly.yaml`, and a snapshotted `output.json`.

## License

Apache-2.0 © Cloudflare, Inc.
