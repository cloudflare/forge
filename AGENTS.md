# Forge Docs Monorepo

API documentation site for Forge OpenAPI specs, built on Astro.

## Architecture

- **`packages/astro-fern`**: Generic Astro engine for rendering Fern-based API documentation.
- **`packages/fern-forge`**: `astro-fern` extension that validates and adapts Forge OpenAPI metadata.
- **`packages/docs-site`**: API documentation website consuming `astro-fern` and `fern-forge`. The OpenAPI spec is fetched from the `openapi.forge.json` GitHub release asset (or a local file via `FORGE_OPENAPI_SPEC`).
- **`packages/docs`**: The documentation site for Forge itself (the generator, its model and its plugins), built with Astro and Nimbus. `packages/docs/AGENTS.md` has its rules.

## Conventions

- **Docs move with the code**: Before finishing any change, check `packages/docs` for every page it affects and update them in the same change. That includes the CLI, the model and its Rust, TypeScript and WIT APIs, OpenAPI rules, extensions, error messages, the built-in targets, and `forge-plugin`. Examples and output on the pages are real, so rerun them rather than editing by hand. `packages/docs/AGENTS.md` has the rules for writing pages.
- **Open Source Separation**: Generic packages (`astro-fern`, `fern-forge`) must remain free of Cloudflare-specific dependencies.
- **Formatting & Linting**: `oxfmt` and `oxlint`, configured only at the root (`.oxfmtrc.json`, `.oxlintrc.json`). `pnpm check` verifies; `pnpm format` rewrites.
- **Type Checking**: Strict TypeScript compiler settings across all packages via `pnpm typecheck`.
- **Tests**: Node-native test runner via `pnpm test` (or `pnpm -r run test`).

## Commands

```bash
# Install dependencies
pnpm install

# Run lint and format checks
pnpm check

# Typecheck all packages
pnpm typecheck

# Run all unit tests
pnpm test

# Build the API documentation site
pnpm --filter docs-site build

# Build the Forge docs site
pnpm --filter forge-docs build
```
