# @cloudflare/redocly-plugin-forge

A [Redocly](https://redocly.com/docs/cli/) plugin that catches a dozen common OpenAPI mistakes on any spec: tag/parameter collisions, invalid or dangling references, missing authentication, malformed examples, inconsistent environment URLs, and more. Each rule fast-paths to a no-op on documents that do not exercise it, so an unused rule costs nothing.

The ruleset was originally extracted from Cloudflare's [Forge](https://github.com/cloudflare/forge) documentation pipeline, where it runs against real-world OpenAPI specs. A smoke run against representative production specs confirmed the rules produce useful, low-false-positive findings on unmodified inputs.

## Install

```bash
pnpm add -D @cloudflare/redocly-plugin-forge
# or
npm install --save-dev @cloudflare/redocly-plugin-forge
```

Requires a peer dependency on `@redocly/openapi-core` ^2.0.0 (satisfied by `@redocly/cli` ^2.0.0).

## Usage

```yaml
# redocly.yaml
plugins:
  - '@cloudflare/redocly-plugin-forge'

extends:
  - forge/recommended

rules:
  # Override a single rule's severity:
  forge/fern-no-complex-query-params: warn
  # Or turn one off:
  forge/fern-no-duplicate-field-names: off
```

### Configs

- `forge/recommended` — every rule in this plugin at its default severity, plus the built-in Redocly rules this plugin relies on (configured to Redocly's recommended subset). This is the only config the plugin ships; override individual rules with `rules:` entries.

### Rule naming

- **Vendor-specific** rules (depend on `x-fern-*` extensions or vendor-specific structure) are prefixed with the vendor: `forge/fern-<base-name>`, e.g. `forge/fern-valid-oauth`. A `grep fern-` finds everything from one vendor.
- **Generator-agnostic** rules use the bare base name: `forge/<base-name>`. None today; future truly generic rules land here.

## Using in CI

### Extending the config

The minimum setup for a CI pipeline:

```yaml
# redocly.yaml
plugins:
  - '@cloudflare/redocly-plugin-forge'
extends:
  - forge/recommended
```

Run with:

```bash
pnpm exec redocly lint path/to/openapi.yaml
```

### Overriding severities per rule

Redocly resolves severities in order: `extends` (earliest to latest), then `rules`. So the pattern for capping a noisy rule is:

```yaml
extends:
  - forge/recommended

rules:
  # Report but do not block CI:
  forge/fern-no-conflicting-endpoint-paths: info
  # Warn but do not block:
  forge/fern-no-complex-query-params: warn
  # Disable entirely:
  forge/fern-no-get-request-body: off
```

### Gradual severity ratchet

When adopting the plugin on a spec with existing findings, prefer lowering severities over disabling rules. A rule at `info` still surfaces every finding in the output; a rule at `off` hides them and makes regressions invisible.

Recommended ratchet:

1. Start with every rule at `warn` or `info` to see the baseline.
2. For each rule with zero findings on your spec, promote to `error` immediately.
3. For each rule with findings, triage: fix the real bugs, then either promote to `error` once clean, or leave at `warn`/`info` while findings are worked down.
4. Re-check on each run; promote rules as the backlog clears.

### Rule-specific CI guidance

- **`forge/fern-no-conflicting-endpoint-paths`** produces many real-but-partly-redundant findings on large specs (one logical conflict can report at several locations). Cap this rule at `info` in CI contexts where blocking on it is not warranted. The findings still appear in the lint output; they just do not fail the build.
- Rules that validate vendor-specific naming conventions (for example, `forge/fern-valid-type-name` and `forge/fern-valid-field-names`) typically produce zero findings on specs that do not use those vendor extensions. They can be adopted at `error` with no cleanup effort.

## Trust model

This plugin runs inside CI pipelines that may execute on protected refs with access to secrets, so the trust boundary matters.

### What the plugin does

- Reads an in-memory OpenAPI document (already parsed by Redocly) and reports lint findings.
- Nothing else.

### What the plugin does not do

- **No network I/O.** No HTTP, DNS, or socket calls at runtime.
- **No filesystem writes.** The plugin does not create, modify, or delete files.
- **No shell execution.** No `child_process.spawn`, `exec`, or dynamic `require` of user-controlled paths.
- **No regex compiled from spec-controlled input.** All regexes in this plugin are literals in source. A malicious spec cannot inject a ReDoS pattern through this plugin.

Future PRs are expected to preserve these properties. CI reviewers should flag any change that adds `fetch`, `http`, `fs.write*`, `child_process`, or dynamic `new RegExp(...)` built from spec-derived strings.

### What a consumer should audit before adopting

- Pin the plugin to an exact version in `package.json` (not a range), so unexpected plugin updates cannot land without review.
- Run `pnpm audit --audit-level=high` (or `npm audit`) against the lockfile before baking the plugin into any CI image. Fail the image build if the audit reports high-severity findings.
- Verify npm provenance on the published tarball: `npm view @cloudflare/redocly-plugin-forge --json` shows the build workflow and commit the artifact was published from. Compare against the tag in this repository.
- Treat the plugin like any other CI dependency: branch-protect the lockfile, require review on changes, and prefer `--frozen-lockfile` installs.

## Development

```bash
pnpm --filter @cloudflare/redocly-plugin-forge typecheck
pnpm --filter @cloudflare/redocly-plugin-forge test
pnpm --filter @cloudflare/redocly-plugin-forge build

# Update fixture snapshots after an intentional change:
pnpm --filter @cloudflare/redocly-plugin-forge test:update
```

Tests use [Vitest](https://vitest.dev/). Fixtures live under `test/fixtures/<base-rule-name>/<case-name>/` with an `openapi.yaml` (or `.json` / `swagger.yaml`), an optional `redocly.yaml`, and a snapshotted `output.json`. Fixture directories are named by the rule's **base** name (without vendor prefix); the harness looks up the matching `RuleDefinition` and uses its prefixed Redocly ID when running the lint.

## Publishing

Releases are triggered by pushing a signed tag matching `redocly-plugin-forge@*` to `main`. The [publish workflow](../../.github/workflows/publish-redocly-plugin-forge.yml) runs `pnpm audit --audit-level=high`, builds with a frozen lockfile, and publishes to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements) attached. See the workflow file for the full set of security guards.

## License

Apache-2.0 © Cloudflare, Inc.
