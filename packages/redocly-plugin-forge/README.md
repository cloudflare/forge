# @cloudflare/redocly-plugin-forge

A [Redocly](https://redocly.com/docs/cli/) plugin bundling lint rules relevant to OpenAPI-driven code generators, with [Forge](https://github.com/cloudflare/forge) in mind. Most rules check OAS-native semantics that apply to any OpenAPI document; a handful validate `x-forge-*` extensions used by Forge.

This plugin began as a port of [`dimitropoulos/redocly-plugin-fern`](https://github.com/dimitropoulos/redocly-plugin-fern), then had its Fern-specific gating stripped so each surviving rule checks OAS-native semantics only.

See [`FUTURE.md`](./FUTURE.md) for candidate rules, scope changes, and built-ins we may adopt later.

## Scope

- One ruleset, `forge`, containing every rule in this plugin.
- Each rule fast-paths to a no-op when its trigger (shape, keyword) is not present, so unused rules cost nothing.
- Consumers opt individual rules in or out through Redocly's standard `rules:` override.

Every rule is exposed as `forge/<rule-name>`. `RuleDefinition.sourceRules` points at the upstream rule (e.g. `fern-definition/no-complex-query-params`) for provenance.

## Usage

```yaml
# redocly.yaml
plugins:
  - '@cloudflare/redocly-plugin-forge'

extends:
  - forge/recommended

rules:
  # opt out of a single rule:
  forge/no-complex-query-params: off
```

### Configs

- `forge/recommended` — every plugin rule at its declared severity, plus the built-in Redocly rules this plugin relies on (configured to the recommended subset).

### Identifier collisions

Four rules catch names that are distinct on the wire but normalize to the same SDK identifier after Forge's `Name::new` word-splitting (so `notification_url` collides with `notificationUrl`, `getBy` with `get_by`, and so on):

- `forge/no-conflicting-parameter-names` — within one operation, path+query+cookie share one namespace and headers share another (ignoring `Accept`, `Content-Type`, and `Authorization`). Also reports repeated path placeholders (`/pets/{id}/toys/{id}`) and placeholders with no letters or digits.
- `forge/no-conflicting-property-names` — properties on the same object schema. Skips `x-forge-skip: true` and `readOnly: true`.
- `forge/no-conflicting-schema-names` — keys under `components.schemas`. Skips `x-forge-skip: true`.
- `forge/no-duplicate-method-name` — `(x-forge-group-name, x-forge-method-name)` pairs across operations and `x-forge-aliases`. An alias inherits its operation's group when it does not declare its own.

Each rule honors the matching `x-forge-*-name` override (`x-forge-parameter-name`, `x-forge-property-name`, `x-forge-model-name`, `x-forge-method-name`) and uses the overridden value for collision detection.

## Development

```bash
pnpm --filter @cloudflare/redocly-plugin-forge typecheck
pnpm --filter @cloudflare/redocly-plugin-forge test

# Update fixture snapshots after an intentional change:
pnpm --filter @cloudflare/redocly-plugin-forge test:update
```

Tests use [Vitest](https://vitest.dev/). Fixtures live under `test/fixtures/<base-rule-name>/<case-name>/` with an `openapi.yaml` (or `.json` / `swagger.yaml`), an optional `redocly.yaml`, and a snapshotted `output.json`.

## License

Apache-2.0 © Cloudflare, Inc.
