# redocly-plugin-generators

A [Redocly](https://redocly.com/docs/cli/) plugin bundling lint rules relevant to OpenAPI-driven code generators (Fern, Stainless, Forge, etc.). Rules are generator-agnostic by default and apply to any generator; vendor-specific rules live in the same ruleset and no-op on documents that don't exercise them.

## Scope

- One ruleset, `generators`, covering every rule in this plugin.
- Vendor-specific rules (e.g. Fern `x-fern-*` extensions, Stainless `x-stainless-*`, Forge `x-forge-*`) are included alongside generator-agnostic rules.
- Each rule fast-paths to a no-op when its trigger (extension, shape, keyword) is not present, so unused rules cost nothing.
- Consumers opt individual rules in or out through Redocly's standard `rules:` override.

Rule naming:

- Vendor-specific: `fern/…`, `stainless/…`, `forge/…` — groups them in docs and makes opt-out readable.
- Generator-agnostic: unprefixed (e.g. `operation-id-missing`).

## Usage

```yaml
# redocly.yaml
plugins:
  - 'redocly-plugin-generators'

extends:
  - generators/recommended

rules:
  # opt out of a single rule:
  generators/operation-id-missing: off
```

Available configs:

- `generators/recommended` — rules at `warn`.
- `generators/all` — every rule at `error`.

## Development

```bash
pnpm --filter redocly-plugin-generators typecheck
pnpm --filter redocly-plugin-generators test
```

## License

Apache-2.0 © Cloudflare, Inc.
