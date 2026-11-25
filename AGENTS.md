# Forge Docs Monorepo

API documentation site for Forge OpenAPI specs, built on Astro.

## Architecture

- **`packages/astro-fern`**: Generic Astro engine for rendering Fern-based API documentation.
- **`packages/fern-forge`**: `astro-fern` extension that validates and adapts Forge OpenAPI metadata.
- **`packages/cloudflare-api-site`**: API documentation website consuming `astro-fern` and `fern-forge`. The OpenAPI spec is fetched from the `openapi.forge.json` GitHub release asset (or a local file via `FORGE_OPENAPI_SPEC`).
- **`packages/cloudflare-terraform-docs`**: Generator for the site's Terraform documentation data, derived from the released Cloudflare Terraform provider. Temporary: removed once Forge supports Terraform natively (see the site's README).
- **`packages/cloudflare-stainless-site`**: Generator for the site's data ported from the retired Stainless API reference: the redirects snapshot of its pages, and its TypeScript, Python and Go samples. Run by hand, since its source is private. Temporary: removed once Forge generates SDK samples and the redirects are retired (see the site's README).
- **`packages/docs`**: The documentation site for Forge itself (the generator, its model and its plugins), built with Astro and Nimbus. `packages/docs/AGENTS.md` has its rules.

## Conventions

- **Docs move with the code**: Before finishing any change, check `packages/docs` for every page it affects and update them in the same change. That includes the CLI, the model and its Rust, TypeScript and WIT APIs, OpenAPI rules, extensions, error messages, the built-in targets, and `forge-plugin`. Examples and output on the pages are real, so rerun them rather than editing by hand. `packages/docs/AGENTS.md` has the rules for writing pages.
- **Open Source Separation**: Generic packages (`astro-fern`, `fern-forge`) must remain free of Cloudflare-specific dependencies.
- **Formatting & Linting**: `oxfmt` and `oxlint`, configured only at the root (`.oxfmtrc.json`, `.oxlintrc.json`). `pnpm check` verifies; `pnpm format` rewrites.
- **Type Checking**: Strict TypeScript compiler settings across all packages via `pnpm typecheck`.
- **Tests**: Node-native test runner via `pnpm test` (or `pnpm -r run test`).
- **Inline Test Data**: JSON written inline in Rust tests (OpenAPI documents and schemas in raw strings) is formatted as if by hand, for readability. Keep new and edited test data in the same shape:
  - Two-space indentation. Content starts two spaces past the indentation of the line that opens the literal, and the closing bracket returns to that indentation.
  - The document skeleton is always expanded, one key per line: the root object, `paths`, each path item, each operation, `components`, and each map under `components`.
  - Other objects and arrays stay on one line when they are short (about 90 characters) and shallow, such as `{"type": "string"}`, `{"title": "t", "version": "1"}`, or a single parameter. Longer ones are expanded to one member per line.
  - A wrapper with a single member (`content`, a media type, `schema`, a response code) shares a line with what it wraps, as in `"requestBody": {"content": {"application/json": {"schema": {`, with the wrapped members indented once and the closing brackets together (`}}}}`).
  - No spaces inside brackets, and `", "` and `": "` as separators.
  - Data whose formatting is under test, such as the minified documents in `tests/normalize`, stays exactly as written.
- **RFCs**: Design proposals and specifications live in `rfcs/`.
- **Writing**: Prose in READMEs, docs, RFCs, doc comments, commit messages and PR text follows the [no-ai-slop](https://github.com/petergyang/no-ai-slop) rules. Say what a thing does, and leave out what it doesn't do unless a reader would expect it to.

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

# Build the API documentation site
pnpm --filter cloudflare-api-site build

# Build the Forge docs site
pnpm --filter forge-docs build
```
