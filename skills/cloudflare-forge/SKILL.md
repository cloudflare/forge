---
name: cloudflare-forge
description: >-
  Understand and use Cloudflare Forge, the schema-first pipeline that turns an OpenAPI 3.x document
  into typed SDKs, CLIs and API documentation. Covers the core model (OpenAPI Overlays, x-forge-* /
  x-fern-* extensions, transformer plugins and chaining, sdk-map.json), building and running the
  TypeScript SDK generator, multi-language SDKs via Fern, and the astro-fern documentation site.
  Use when asked what Forge is or whether it fits a project, generating SDKs/CLIs/docs from OpenAPI,
  writing Forge overlays or custom transformers, or debugging a Forge build or generation failure;
  triggers on "forge", "cloudflare forge", "generate SDK from OpenAPI", "generate CLI from OpenAPI",
  "OpenAPI overlay", "x-forge", "sdk-map", "fern generate", "SDK generation pipeline",
  "API reference docs from OpenAPI".
compatibility: >-
  Node >= 22 and pnpm 10 to build from source; Docker for SDK generation (Fern generator images);
  gh CLI to download release assets.
---

# Cloudflare Forge

Forge is an **orchestration layer over OpenAPI**: resolve the spec → apply overlays → build a
command/method model → hand it to transformers that emit artifacts (SDKs, CLIs, docs, Zod schemas,
MCP servers, ...). SDK source code is produced by Fern's open-source generators running in Docker;
Forge prepares their input, applies Fern compatibility repairs, emits `sdk-map.json`, and chains
downstream generators.

- Repository: <https://github.com/cloudflare/forge>
- Announcement: <https://blog.cloudflare.com/forge-open-source-generation-pipeline/>

## Pick a path

| Goal                                                                     | Read                                                                       |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Explain Forge / decide whether it fits                                   | "Architecture" and "When Forge fits" below                                 |
| Generate a TS SDK for an OpenAPI document                                | "Quick start" below + [references/generation.md](references/generation.md) |
| Rename/group SDK methods, hide operations, tune CLI args                 | [references/overlays.md](references/overlays.md)                           |
| Write a custom generator (Zod, MCP, internal CLI, endpoint catalog, ...) | [references/transformer-api.md](references/transformer-api.md)             |
| Multi-language SDKs, docs site, `sdk-map.json`                           | [references/generation.md](references/generation.md)                       |

## Architecture

```
OpenAPI 3.x (bundled JSON)
   │
   ├─ JSONPath overlays (optional; OpenAPI Overlay Spec 1.0.0, patched per operationId)
   ▼
@cloudflare/forge core
   ├─ OpenApiResolver: $ref dereferencing; path/query/header/body parameter extraction
   ├─ Schema model: command → methodGroup → method (from dotted x-fern-sdk-group-name)
   └─ Plugin lifecycle: init → transform(fn) → finalize(dir)
   ▼
Transformers (chainable: one transformer's output feeds the next)
   ├─ forge-transformer-sdk-ts: Fern TS generator + compatibility repairs + sdk-map.json
   ├─ CLI generators: read sdk-map.json to emit typed SDK calls
   └─ Docs: astro-fern + fern-forge → Astro site, plus agent Markdown and llms.txt
```

| Package                                        | Role                                                          | Generic?                    |
| ---------------------------------------------- | ------------------------------------------------------------- | --------------------------- |
| `packages/forge`                               | Core engine (resolver, overlays, Schema, `Forge` class)       | yes                         |
| `packages/astro-fern`                          | Generic Astro docs engine (OpenAPI → routes/content/llms.txt) | yes                         |
| `packages/fern-forge`                          | astro-fern extension that validates and adapts Forge metadata | yes                         |
| `packages/cloudflare-forge-transformer-sdk-ts` | Standalone TS SDK generator CLI (bin `forge`)                 | Cloudflare-specific runtime |
| `packages/cloudflare-fern-config`              | Multi-language Fern `generators.yml` + `generate-sdk.ts`      | Cloudflare only             |
| `packages/cloudflare-forge-sdk-{lang}`         | Per-language SDK workspace wrappers                           | Cloudflare only             |
| `packages/docs-site`                           | Cloudflare's API reference site (deployed to Workers)         | Cloudflare only             |

## Quick start: TS SDK for an OpenAPI document

The packages are not published to npm yet, so build the generator from source:

```bash
git clone --depth 1 https://github.com/cloudflare/forge && cd forge
pnpm install

# build-package.ts reads these two gitignored specs to package the Cloudflare baseline SDK.
# Download the published spec, or use a minimal placeholder when targeting a different API.
STUB='{"openapi":"3.0.3","info":{"title":"stub","version":"0"},"paths":{}}'
echo "$STUB" > openapi.json
echo "$STUB" > packages/cloudflare-fern-config/fern/openapi.json

pnpm --filter @cloudflare/forge-transformer-sdk-ts build

# Docker must be running.
node packages/cloudflare-forge-transformer-sdk-ts/dist/cli.js /abs/path/openapi.json --out ./generated
```

Output:

- `generated/sdk/`: Fern-generated TS SDK source plus `sdk-map.json`
- `generated/openapi.json`: the input spec as given

The input must be a **single bundled JSON document** (no cross-file `$ref`); `-` reads stdin. Generation builds a
wrapper image over the pinned `fernapi/fern-typescript-sdk` version; details and environment variables are in
[references/generation.md](references/generation.md).

## When Forge fits

- One spec must drive SDK + CLI + docs consistently across many operations and teams
- You want per-PR preview generation in CI and review only what a change affects
- You need to reshape SDK/CLI naming without editing the service-owned spec (overlays)
- You want to add your own generators on top of the same resolved model (transformers)

If you only need an SDK and none of overlays, chained transformers or `sdk-map.json`, running Fern directly
(`fern generate --local`) produces the same generator output with less setup.

## Things to know

1. **Plain specs produce no commands**: `init()` only turns operations that carry `x-fern-sdk-group-name` into
   commands, so `forge.commands` is empty otherwise (queries such as `getOperationIds()` still work). Building
   commands also requires every operation to have a `description` or `summary`.
2. **`getVerbPath(id)` returns a string** such as `"GET /users"`. Use `resolveOperation(operationId)` for
   structured path, method and parameter data.
3. **The TS SDK runtime is Cloudflare-flavoured**: the Fern organization is `cloudflare` (client class
   `CloudflareApiClient`), and `unwrapCloudflareEnvelope` unwraps any response body containing both `success`
   and `result`, throwing `CloudflareApiEnvelopeError` when `success` is `false`.
4. **Large specs need memory**: the generator wrapper defaults to an 8 GB Node heap
   (`FERN_NODE_MAX_OLD_SPACE_SIZE`); exit code 133 means it ran out. Give Docker enough memory.
5. **Overlay targets**: only `$` (root merge) and `$.paths.*[?@.operationId=="<id>"]` are accepted.
6. **Release lookup**: without `FORGE_OPENAPI_RELEASE`, `generate-sdk.ts` picks the newest release tagged
   `openapi.vYYYYMMDD.N`; pin the variable to use a release with a different tag format.
