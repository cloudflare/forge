# SDK and docs generation

## TS SDK generator CLI (`@cloudflare/forge-transformer-sdk-ts`)

Source: `packages/cloudflare-forge-transformer-sdk-ts/scripts/generate-from-openapi.ts` (the CLI)
and `scripts/build-package.ts` (bundles it into `dist/`). The bins are `forge` and
`forge-transformer-sdk-ts`.

```
forge [openapi.json|-] --out <dir> [--base <file.json>]
```

Two modes:

| Invocation                         | Behaviour                                                                                                           | Docker     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------- |
| `forge spec.json --out dir`        | Real generation: sharded Fern generation                                                                            | required   |
| `forge --base spec.json --out dir` | No generation: unpacks the packaged Cloudflare baseline SDK (`baseline-sdk.tar`); `--base` is only copied alongside | not needed |

The second mode is only meaningful for Cloudflare's own API; use the first for any other spec.

### Generation steps (first mode)

1. Check `docker --version`; write the input spec into a temp directory.
2. `applyFernCompatibilityFixes`: rewrite OpenAPI shapes Fern 3.80 mishandles (for example
   properties next to an undiscriminated `oneOf`, or inconsistent naming of inline
   `map<string, array<object>>` types). The number of repairs is printed to stderr.
3. `build-generator-image.sh typescript 3.80.1`: build a wrapper over
   `fernapi/fern-typescript-sdk:3.80.1` and **retag it over the official name**, with a larger
   Node heap and the host CA installed; reused from cache when inputs are unchanged.
4. Write a temporary Fern workspace (organization hard-coded to `cloudflare`, fern-api 5.112.0);
   `generate-fern-typescript-sharded.sh` generates from one Fern IR in N parallel shards and
   merges them.
5. Copy in the custom runtime (`getResponseBody.ts`, `unwrapCloudflareEnvelope.ts`).
6. Generate `sdk-map.json`.
7. Write `out/sdk/` (SDK source + `sdk-map.json`) and `out/openapi.json` (the input spec as given).

### Environment variables

| Variable                             | Default      | Effect                                                                       |
| ------------------------------------ | ------------ | ---------------------------------------------------------------------------- |
| `FERN_NODE_MAX_OLD_SPACE_SIZE`       | 8192         | Node heap (MB) inside the wrapper image; exit code 133 means it is too small |
| `FERN_NODE_STACK_SIZE`               | 8192         | Node stack size                                                              |
| `FERN_TYPESCRIPT_SHARD_COUNT`        | 3            | Number of shards                                                             |
| `FERN_TYPESCRIPT_SHARD_HEAP_MB`      | 2304         | Heap per shard (MB)                                                          |
| `FERN_GENERATOR_HOST_CA_PEM`         | empty        | PEM file to install in the image, for TLS-intercepting corporate proxies     |
| `FERN_GENERATOR_HOST_CA_COMMON_NAME` | `Cloudflare` | On macOS without a PEM, the certificate CN searched for in the keychain      |

If `go mod` / `pip` / `cargo` fail TLS verification inside the generator container, you are
probably behind an intercepting proxy: set `FERN_GENERATOR_HOST_CA_PEM`.

### Fixed settings of the generated SDK

These come from the `generators.yml` the CLI writes; changing them means editing the source and
rebuilding: native `fetch`, `maxRetries: 2`, `retryStatusCodes: recommended`,
`skipResponseValidation: true`, `streamType: web`, `omitUndefined: true`,
`offsetSemantics: page-index`, `formatter: oxfmt`, `linter: oxlint`, plus Fern spec settings such
as `coerce-enums-to-literals`, `path-parameter-order: url-order` and `resolve-schema-collisions`.

## `sdk-map.json`

Maps each operationId to its generated SDK call site: accessor chain (e.g. `client.users.tokens`),
method name, request type name and response type name.

- Derived from the generated source, never hand-written: it walks the `*Client` getters of
  `CloudflareApiClient`, then matches the `handleNonStatusCodeError(err, raw, VERB, PATH)`
  literals at the end of each method body.
- Operations without an operationId get the synthetic key `generated:<method>:<path>`.
- **Coverage is enforced**: generation fails if any non-ignored operation (including deprecated
  ones Fern still generates) does not resolve to an entry.
- Purpose: downstream CLI generators join on operationId to emit typed SDK calls instead of the
  raw `.fetch()` passthrough, with no SDK-name guessing. This is the link in the
  "OpenAPI → TS SDK → cf CLI" chain described in the blog post.

## Multi-language SDKs (Cloudflare configuration)

`packages/cloudflare-fern-config`: `fern/generators.yml` defines one `<lang>-sdk` group per
language (generator versions are pinned there); `scripts/generate-sdk.ts` prepares the spec,
builds the wrapper image and runs `fern generate --local`.

```bash
pnpm --filter @cloudflare/fern-config run generate                 # typescript (default group)
pnpm --filter @cloudflare/fern-config run generate python go rust  # any number of languages
```

Spec source, in order of precedence:
1. `FORGE_OPENAPI_SPEC=<local file>`: copied to `fern/openapi.json`.
2. An existing non-empty `fern/openapi.json`: used as-is.
3. Download `openapi.forge.json` from a GitHub release: `FORGE_OPENAPI_RELEASE=<tag>` pins the
   tag; when unset, the newest tag matching `openapi.vYYYYMMDD.N` is used. Releases tagged
   differently (e.g. `openapi@<sha>`) must be pinned explicitly.

For a non-Cloudflare API, change the organization, package names and output paths in
`generators.yml`; at that point this is essentially plain Fern.

CI: `.github/workflows/sdk-typescript.yml` (TS + sdk-map) and `sdk-languages.yml` (other
languages). The `auto` flag per language in `.github/sdk-languages.json` controls whether a
language generates on pull requests and pushes to main; disabled languages can still run through
`workflow_dispatch`.

## Docs site

- `astro-fern`: generic Astro engine for OpenAPI loading, manifests, version snapshots, snippets,
  route planning, agent Markdown and `llms.txt`. It does not depend on Starlight; its README is a
  full configuration guide.
- `fern-forge`: astro-fern extension. Register it with
  `defineFernCollections({ extensions: [forgeExtension()] })` and pass the spec through
  `hoistForgeCommands(spec)` to bring Forge metadata into the docs.
- `docs-site`: Cloudflare's own site (Astro + Starlight + Workers adapter), reading `openapi.json`
  from the main branch of `cloudflare/api-schemas`. Run locally from the repo root:

```bash
pnpm --filter docs-site dev
```

URLs follow the SDK grouping (e.g. `/api/zero-trust/devices/ip-profiles/methods/list/`); `?lang=`
selects the code-sample language and `?version=` a snapshot. Every page has a `.md` twin, and
there is `/api/llms.txt`. The docs path needs **no** Fern generation, Docker or registry access.
