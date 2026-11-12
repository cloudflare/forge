# @cloudflare/redocly-plugin-generators

A [Redocly](https://redocly.com/docs/cli/) plugin bundling lint rules relevant to OpenAPI-driven code generators (Fern, Stainless, Forge, etc.). Rules are generator-agnostic and apply to any OpenAPI document; vendor-specific infrastructure is left in place for future `generators/forge-*` rules that validate `x-forge-*` extensions.

This plugin began as a port of [`dimitropoulos/redocly-plugin-fern`](https://github.com/dimitropoulos/redocly-plugin-fern), then had its Fern-specific gating stripped so each surviving rule checks OAS-native semantics only. See `RULE_AUDIT.md` for the per-rule conversion and deletion log.

## Scope

- One ruleset, `generators`, containing every rule in this plugin.
- Each rule fast-paths to a no-op when its trigger (shape, keyword) is not present, so unused rules cost nothing.
- Consumers opt individual rules in or out through Redocly's standard `rules:` override.

### Rule naming

- **Generator-agnostic**: `generators/<base-name>` — no vendor prefix. Every rule today is in this bucket.
- **Vendor-specific** (future): `generators/<vendor>-<base-name>` — e.g. a planned `generators/forge-*` family for `x-forge-*` extension validation. A rule declares its vendor in its `RuleDefinition` (`vendor: 'forge'`); the plugin derives the prefixed Redocly rule ID mechanically. `RuleDefinition.sourceRules` points at the upstream rule (e.g. `fern-definition/no-complex-query-params`) for provenance.

## Usage

```yaml
# redocly.yaml
plugins:
  - '@cloudflare/redocly-plugin-generators'

extends:
  - generators/recommended

rules:
  # opt out of a single rule:
  generators/no-complex-query-params: off
```

### Configs

- `generators/recommended` — rules at their default severity. Also enables the built-in Redocly rules this plugin relies on (configured to the recommended subset).
- `generators/all` — every plugin rule at `error`, plus all the built-in Redocly rules.

Vendor-specific configs (e.g. `generators/forge`) will be added alongside the first `generators/forge-*` rule.

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
