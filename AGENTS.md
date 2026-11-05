# Forge Docs Monorepo

API documentation site for Forge OpenAPI specs, built on Astro.

## Architecture

- **`packages/astro-fern`**: Generic Astro engine for rendering Fern-based API documentation.
- **`packages/fern-forge`**: `astro-fern` extension that validates and adapts Forge OpenAPI metadata.
- **`packages/docs-site`**: API documentation website consuming `astro-fern` and `fern-forge`. The OpenAPI spec is fetched from the `openapi.forge.json` GitHub release asset (or a local file via `FORGE_OPENAPI_SPEC`).
- **`packages/cloudflare-terraform-docs`**: Generator for the site's Terraform documentation data, derived from the released Cloudflare Terraform provider. Temporary: removed once Forge supports Terraform natively (see the site's README).

## Conventions

- **Open Source Separation**: Generic packages (`astro-fern`, `fern-forge`) must remain free of Cloudflare-specific dependencies.
- **Formatting & Linting**: `oxfmt` and `oxlint`, configured only at the root (`.oxfmtrc.json`, `.oxlintrc.json`). `pnpm check` verifies; `pnpm format` rewrites.
- **Type Checking**: Strict TypeScript compiler settings across all packages via `pnpm typecheck`.
- **Tests**: Node-native test runner via `pnpm test` (or `pnpm -r run test`).
- **RFCs**: Design proposals and specifications live in `rfcs/`.

## Public Repository

Never publish links to Cloudflare-internal systems (anything behind Cloudflare's network or login) in files, commits, branch names, or PR and issue text. Bare ticket IDs (`FORGE-1`) are fine. A pushed link stays in history even after a later commit removes it: tell the maintainers.

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

# Build the docs site
pnpm --filter docs-site build
```
