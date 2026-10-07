# docs-site

Cloudflare's deployable API reference, built with Astro,
[Nimbus](https://nimbus-docs.com), and `astro-fern`.

This package intentionally owns the renderer. Nimbus scaffolds its layouts,
components, and styles into `src/` as files the site owns; sidebar
construction, schema presentation, execution-target controls, and CSS live here
too. `astro-fern` supplies the normalized content and lazy server APIs without
depending on Nimbus.

## Data flow

```text
OpenAPI source or version-bound snapshots
                           +
        src/content.config.ts manifest
                           |
                           v
              route-neutral apiReference
                           +
        astro.config.mjs runtime routing
                           |
                           v
              astro-fern server composition
              /             |             \
 API operation pages      |      agent Markdown
                            |      and llms.txt
                     target metadata
```

The OpenAPI specification is loaded from the `openapi.forge.json` asset on the
latest stable Forge GitHub release. Set `FORGE_OPENAPI_RELEASE` to a release tag
to build against that exact revision. The released artifact keeps normal docs
development free of Fern generation, Docker, and registry access. Fern SDK group
and method metadata defines each public product, resource hierarchy, and method
route. OpenAPI tags remain internal ownership metadata and do not appear in
SDK-backed URLs.

## Project ownership

- `src/content.config.ts` selects OpenAPI sources, discovers SDK products and ownership sections, configures snapshots and execution targets, and registers the canonical, route-neutral API collection. Data-only collections are prefixed with `_` so Nimbus leaves them out of its Markdown and `llms.txt` index.
- `astro.config.mjs` independently configures routing and installs Nimbus, `astro-fern`, and the Cloudflare adapter. `astro-fern` is registered after Nimbus because Nimbus replaces Astro's Markdown processor and `astro-fern` installs its sanitizer into the active one.
- `src/api-routing.ts` owns the query-parameter URL policy and semantic link resolution.
- `src/api-server.ts` binds that policy to `astro-fern`'s lazy server APIs.
- `src/pages/[product]/[...slug].astro` owns the SSR human operation route and renderer.
- `src/pages/[...slug].astro` renders authored pages from `src/content/docs/` on request, with the same API sidebar.
- `src/pages/[...document].md.ts` and the `llms.txt` endpoints own the SSR agent routes. `llms.txt` and `[product]/llms.txt` combine the astro-fern API index with the authored-page index Nimbus prepares at build time; `[...slug]/index.md`, `index.mdx`, and `llms-full.txt` are Nimbus routes for authored pages.
- `src/layouts/` and `src/components/ui/` are the Nimbus page shells and UI components; `src/components/` also contains the operation, schema, and code UI.
- `src/sidebar.ts` maps the selected version and execution target into Nimbus sidebar items, and `src/page-sidebar.ts` resolves them for a request.
- `src/styles/globals.css` holds the Cloudflare palette as Nimbus `--nb-*` tokens; `src/styles/cloudflare.css` aliases them as the `--cf-*` tokens used by the API components.

### Styling

Files copied from Nimbus (`src/layouts/`, `src/components/ui/`, `src/styles/globals.css`, and `prose.css`) keep Nimbus's Tailwind classes so registry updates still apply. Everything else — the API reference, the header, and the sidebar rows — uses scoped or plain CSS with the `--cf-*` and `--nb-*` tokens. Do not put utility classes on markup that repeats at scale: the API sidebar renders thousands of rows per page, and per-row class strings multiply page size.

Products are discovered across the configured OpenAPI source set. Routes,
navigation, agent indexes, and server-island lookups are composed from that
content and the independent runtime config.

## Routes

Human operation pages are rendered on demand by the Astro catch-all route.
`lang` selects an execution target and `version` selects an exact documentation
snapshot:

```text
/api/zero-trust/devices/ip-profiles/
/api/zero-trust/devices/ip-profiles/methods/list/
/api/zero-trust/devices/ip-profiles/methods/list/?lang=typescript
```

Omitting `version` selects the configured default version; omitting `lang`
selects the first configured target for HTML while agent Markdown remains
aggregate. On API and agent routes, empty, duplicate, or unknown selection
parameters return 404 rather than silently falling back. Previous version/target
path variants are not routes.

Each snapshot owns its products, resources, operations, and operation slugs. A
historical-only operation remains reachable at its historical slug with
`?version=<id>`. Switching versions follows the same OpenAPI `operationId` and
SDK projection identity when that placement exists in the target snapshot.
Products absent from the selected snapshot are omitted from navigation; the
router never substitutes another product snapshot.

The current recipe exposes one catalog snapshot backed by a released OpenAPI
artifact. The API-version selector remains visible with that one option. Selector
options come from the generated catalog and include only snapshots available to
the current page. Generated request samples remain version-neutral and do not
send an `api-version` header until API version enforcement is implemented
upstream.

Until upstream SDK addresses distinguish account and zone operations that share
one route, equal-priority collisions temporarily prefer the account-scoped
operation. Forge approval metadata remains authoritative, so a hidden account
mapping still loses to an approved zone mapping.

Agent routes use the same query policy and are rendered on demand:

```text
/api/llms.txt
/api/zero-trust/llms.txt
/api/zero-trust/llms.txt?lang=typescript
/api/zero-trust/devices/ip-profiles/methods/list.md
/api/zero-trust/devices/ip-profiles/methods/list.md?lang=typescript
```

Canonical human pages link to aggregate Markdown; a selected execution target
links to the matching target Markdown.

## Server islands

Operation content is rendered on demand. Every operation page and deferred schema island
loads by both semantic entry ID and selected version so it resolves the exact
snapshot artifact. Schema sections above the local node-count threshold use
Astro server islands to keep very large unions out of the initial HTML. The
Cloudflare adapter supplies the Worker runtime; pages and islands read the
already-generated `astro-fern` content collections and never access the
filesystem. Code samples use Prism's JavaScript highlighter because Shiki's
WebAssembly runtime is unavailable in the deployed Worker.

## Run it

From the repository root after `pnpm install`:

```bash
pnpm --filter docs-site dev
pnpm --filter docs-site check
pnpm --filter docs-site build
pnpm --filter docs-site preview
```

To reproduce a release-triggered build, pin the release asset:

```bash
FORGE_OPENAPI_RELEASE='openapi@<api-schemas-commit>' pnpm --filter docs-site build
```

Set `FORGE_OPENAPI_SPEC` to an already-downloaded artifact to build without
downloading it again.

`check` validates the Astro components. `build` verifies the Cloudflare SSR
bundle.
