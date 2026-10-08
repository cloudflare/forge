# Forge Monorepo

Open-source schema-first OpenAPI code generation and surface tooling framework.

## Architecture

- **`packages/forge`**: Core engine — OpenAPI 3.x resolver, typed schema model, JSONPath overlays, and plugin lifecycle.
- **`packages/astro-fern`**: Generic Astro engine for rendering Fern-based API documentation.
- **`packages/cloudflare-api-site`**: Cloudflare API reference website, built with Nimbus and `astro-fern`.
- **`packages/cloudflare-fern-config`**: Fern generator configuration (`generators.yml`, `fern.config.json`).
- **`packages/cloudflare-forge-sdk-ts`**: TypeScript SDK package wrapper and `sdk-map` generator.
- **`packages/cloudflare-forge-transformer-sdk-ts`**: Standalone TypeScript SDK transformer bundle.
- **`packages/cloudflare-forge-sdk-{lang}`**: Language-specific SDK workspace wrappers (Python, Go, Java, PHP, C#, Ruby, Rust, Swift).

## Conventions

- **Open Source Separation**: Generic packages (`forge`, `astro-fern`) must remain free of Cloudflare-specific dependencies. All Cloudflare-specific SDK wrappers and configurations must be prefixed with `cloudflare-*`.
- **Formatting & Linting**: `oxfmt` and `oxlint` via `pnpm check`.
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
```
