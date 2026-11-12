# @cloudflare/redocly-plugin-generators

A [Redocly](https://redocly.com/docs/cli/) plugin bundling lint rules relevant to OpenAPI-driven code generators (Fern, Stainless, Forge, etc.). Generator-agnostic rules apply to any OpenAPI document; vendor-specific rules validate `x-<vendor>-*` extensions for a single generator and opt in via a vendor config.

This plugin began as a port of [`dimitropoulos/redocly-plugin-fern`](https://github.com/dimitropoulos/redocly-plugin-fern), then had its Fern-specific gating stripped so each surviving rule checks OAS-native semantics only.

See [`FUTURE.md`](./FUTURE.md) for candidate rules, scope changes, and built-ins we may adopt later.

## Scope

- One ruleset, `generators`, containing every rule in this plugin.
- Each rule fast-paths to a no-op when its trigger (shape, keyword) is not present, so unused rules cost nothing.
- Consumers opt individual rules in or out through Redocly's standard `rules:` override.

### Rule naming

- **Generator-agnostic**: `generators/<base-name>` — no vendor prefix. Enabled by `generators/recommended`.
- **Vendor-specific**: `generators/<vendor>-<base-name>` — e.g. the `generators/forge-*` family that validates `x-forge-*` extensions. A rule declares its vendor in its `RuleDefinition` (`vendor: 'forge'`); the plugin derives the prefixed Redocly rule ID mechanically. Enabled only via the matching vendor config (e.g. `generators/forge`). `RuleDefinition.sourceRules` points at the upstream rule (e.g. `fern-definition/no-complex-query-params`) for provenance.

## Usage

```yaml
# redocly.yaml
plugins:
  - '@cloudflare/redocly-plugin-generators'

extends:
  - generators/recommended
  # Enable Forge extension rules in addition:
  # - generators/forge

rules:
  # opt out of a single rule:
  generators/no-complex-query-params: off
```

### Configs

- `generators/recommended` — generator-agnostic rules at their default severity. Also enables the built-in Redocly rules this plugin relies on (configured to the recommended subset). Does not enable vendor-specific rules.
- `generators/forge` — everything in `generators/recommended` plus the `generators/forge-*` rules that validate `x-forge-*` extensions. Use this when the spec is consumed by [Forge](https://github.com/cloudflare/forge).
- `generators/all` — every plugin rule (generator-agnostic and vendor-specific) at `error`, plus all the built-in Redocly rules.

## Development

```bash
pnpm --filter @cloudflare/redocly-plugin-generators typecheck
pnpm --filter @cloudflare/redocly-plugin-generators test

# Update fixture snapshots after an intentional change:
pnpm --filter @cloudflare/redocly-plugin-generators test:update
```

Tests use [Vitest](https://vitest.dev/). Fixtures live under `test/fixtures/<base-rule-name>/<case-name>/` with an `openapi.yaml` (or `.json` / `swagger.yaml`), an optional `redocly.yaml`, and a snapshotted `output.json`.

## License

Apache-2.0 © Cloudflare, Inc.
