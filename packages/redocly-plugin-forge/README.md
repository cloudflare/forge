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
