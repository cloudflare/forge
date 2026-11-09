# redocly-plugin-generators

A [Redocly](https://redocly.com/docs/cli/) plugin bundling lint rules relevant to OpenAPI-driven code generators (Fern, Stainless, Forge, etc.). Vendor-specific rules sit alongside generator-agnostic ones in a single ruleset, and no-op on documents that don't exercise them.

This plugin is a port of [`dimitropoulos/redocly-plugin-fern`](https://github.com/dimitropoulos/redocly-plugin-fern) into the Forge monorepo, generalised beyond Fern.

## Scope

- One ruleset, `generators`, containing every rule in this plugin.
- Vendor-specific rules are prefixed in their Redocly rule ID so a quick `grep fern-` finds everything from a single vendor. Generator-agnostic rules (none today) stay unprefixed.
- Each rule fast-paths to a no-op when its trigger (extension, shape, keyword) is not present, so unused rules cost nothing.
- Consumers opt individual rules in or out through Redocly's standard `rules:` override.

### Rule naming

- **Vendor-specific** (e.g. depends on `x-fern-*` extensions or Fern-specific structure): `generators/fern-<base-name>` — for instance `generators/fern-valid-oauth`, `generators/fern-no-duplicate-field-names`. Stainless and Forge rules, when added, will follow the same pattern (`generators/stainless-*`, `generators/forge-*`).
- **Generator-agnostic**: `generators/<base-name>` — no vendor prefix. None today; future truly generic rules land here.

A rule declares its vendor in its `RuleDefinition` (`vendor: 'fern'` etc., omitted for agnostic rules); the plugin derives the prefixed Redocly rule ID mechanically. `RuleDefinition.sourceRules` points at the upstream rule (e.g. `fern-definition/no-duplicate-field-names`) for provenance.

## Usage

```yaml
# redocly.yaml
plugins:
  - 'redocly-plugin-generators'

extends:
  - generators/recommended

rules:
  # opt out of a single rule:
  generators/fern-no-complex-query-params: off
```

### Configs

- `generators/recommended` — rules at their default severity. Also enables the built-in Redocly rules this plugin relies on (configured to the recommended subset).
- `generators/all` — every plugin rule at `error`, plus all the built-in Redocly rules.
- `generators/fern` — only rules targeting Fern, at their default severity. Plus the generator-agnostic rules (since those apply to every generator) and the recommended built-in Redocly rules.
- `generators/stainless` — same shape, for Stainless. Empty of plugin rules today; a forward-looking placeholder.
- `generators/forge` — same shape, for Forge. Empty of plugin rules today.

## Development

```bash
pnpm --filter redocly-plugin-generators typecheck
pnpm --filter redocly-plugin-generators test

# Update fixture snapshots after an intentional change:
pnpm --filter redocly-plugin-generators test:update
```

Tests use [Vitest](https://vitest.dev/). Fixtures live under `test/fixtures/<base-rule-name>/<case-name>/` with an `openapi.yaml` (or `.json` / `swagger.yaml`), an optional `redocly.yaml`, and a snapshotted `output.json`. Fixture directories are named by the rule's **base** name (without vendor prefix); the harness looks up the matching `RuleDefinition` and uses its prefixed Redocly ID when running the lint.

## License

Apache-2.0 © Cloudflare, Inc.
