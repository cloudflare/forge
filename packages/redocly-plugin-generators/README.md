# redocly-plugin-generators

A [Redocly](https://redocly.com/docs/cli/) plugin bundling lint rules relevant to OpenAPI-driven code generators (Fern, Stainless, Forge, etc.). Rules are generator-agnostic by default; vendor-specific rules live in the same ruleset and no-op on documents that don't exercise them.

This plugin is a port of [`dimitropoulos/redocly-plugin-fern`](https://github.com/dimitropoulos/redocly-plugin-fern) into the Forge monorepo, generalised beyond Fern.

## Scope

- One ruleset, `generators`, covering every rule in this plugin.
- Vendor-specific rules (e.g. Fern `x-fern-*` extensions) are included alongside generator-agnostic rules. Stainless and Forge rules will be added over time.
- Each rule fast-paths to a no-op when its trigger (extension, shape, keyword) is not present, so unused rules cost nothing.
- Consumers opt individual rules in or out through Redocly's standard `rules:` override.

Rule naming:

- Generator-agnostic: unprefixed (e.g. `no-conflicting-endpoint-paths`).
- Vendor-specific: carry the vendor in the description and the `sourceRules` metadata. A naming prefix (`fern/…`, `stainless/…`, `forge/…`) may be introduced if ambiguity emerges.

Each `RuleDefinition` carries a `sourceRules` field listing the upstream rules it ports (e.g. `fern-definition/no-duplicate-field-names`) — documentation, not behavior.

## Usage

```yaml
# redocly.yaml
plugins:
  - 'redocly-plugin-generators'

extends:
  - generators/recommended

rules:
  # opt out of a single rule:
  generators/no-complex-query-params: off
```

Available configs:

- `generators/recommended` — rules at their default severity. Also enables the built-in Redocly rules this plugin relies on.
- `generators/all` — every plugin rule at `error`, plus the same built-in Redocly rules.

## Development

```bash
pnpm --filter redocly-plugin-generators typecheck
pnpm --filter redocly-plugin-generators test

# Update fixture snapshots after an intentional change:
pnpm --filter redocly-plugin-generators test:update
```

Tests use [Vitest](https://vitest.dev/). Fixtures live under `test/fixtures/<rule-name>/<case-name>/` with an `openapi.yaml` (or `.json` / `swagger.yaml`), an optional `redocly.yaml`, and a snapshotted `output.json`.

## License

Apache-2.0 © Cloudflare, Inc.
