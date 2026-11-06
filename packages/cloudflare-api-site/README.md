# cloudflare-api-site

Cloudflare's deployable API reference, built with Astro,
[Nimbus](https://nimbus-docs.com), and `astro-fern`.

Nimbus renders the API pages, their Markdown twins, and `llms.txt`. `astro-fern`
reads the Forge OpenAPI spec at build time and decides products, resources, and
operation URLs. `src/forge-api.ts` translates one into the other; it adds
Cloudflare data to the spec and never renders anything itself.

## Data flow

```text
openapi.json (cloudflare/api-schemas)
                 |
                 v
   astro-fern buildFernContent
   products, resources, routes, Terraform data
                 |
                 v
   prepareForgeApi (src/forge-api.ts)
                 |
                 v
   .forge/  spec, products, redirects
                 |
                 v
   Nimbus api collection
   /     |        \
 pages  Markdown  llms.txt
```

The spec is `openapi.json` from
[`cloudflare/api-schemas`](https://github.com/cloudflare/api-schemas), loaded by
`src/openapi-source.ts` at the head of `main` unless a commit is pinned; see
[API versions](#api-versions). Fern SDK group and method metadata defines each
public product, resource hierarchy, and method route. OpenAPI tags remain
internal ownership metadata and do not appear in URLs.

`prepareForgeApi` writes three files to the git-ignored `.forge/` directory:

- `openapi-<version>.json`: the spec Nimbus renders, with Cloudflare titles,
  `x-nimbus-order` for lifecycle order, request samples, synthesized response
  examples, and Terraform data under `x-cloudflare-terraform`;
- `products.json`: the products and their slugs, read by the command sidebar;
- `redirects.json`: old section, alias-operation, and moved-product URLs, read by
  `src/middleware.ts`.

Operations with removed Forge metadata are left out with a build warning.
Operations `astro-fern` gives no URL are left out silently.

Until upstream SDK addresses distinguish account and zone operations that share
one route, equal-priority collisions prefer the account-scoped operation
(`cloudflareOperationRoutingPreference` in `src/cloudflare.ts`). Forge approval
metadata remains authoritative, so a hidden account mapping still loses to an
approved zone mapping.

## Project ownership

- `astro.config.mjs` installs Nimbus with the API entry from `forgeApi()` and the
  Cloudflare adapter. API pages render on request. It lists the icons the site
  uses, so only those reach the Worker; add an icon there before using it.
- `src/forge-api.ts` builds the `astro-fern` content and prepares the spec, as
  above. `src/cloudflare.ts` holds the execution targets, snippets, and routing
  preferences it uses, and `src/version.ts` the API version.
- `src/content.config.ts` registers Nimbus's `api` collection and the `cf`
  command catalog; `src/live.config.ts` registers Nimbus's live API pages.
- `src/pages/[...slug].astro` renders every API page with Nimbus's
  `getApiRoute`; `src/plain-text.ts` turns a description into its meta
  description.
- `src/pages/[...slug]/index.md.ts`, `llms.txt.ts`, `[...section]/llms.txt.ts`,
  and `llms-full.txt.ts` are Nimbus's agent routes. A Markdown twin lives at
  `/<page>/index.md`; `[...slug].md.ts` 301s the old `/<page>.md` URLs to it.
  Its frontmatter leaves out the description, which the body repeats.
- `src/middleware.ts` 302s the URLs in `.forge/redirects.json` to their pages.
- `src/command-reference/`, `src/command-sidebar.ts`, `src/pages/tooling/`, and
  `src/pages/[product]/tooling/` own the `cf` command pages. They render on
  request, inside `CommandPage.astro`, with the same API sidebar as the API
  pages (`ApiNavigation.astro`), opened at the overview or the command's product.
  The catalog in `src/command-reference/_generated/` is copied from
  `cloudflare/cf`; replace it to refresh the commands.
- `src/components/ui/` holds the Nimbus starter components the site owns,
  including the API layout, sidebar, field rows, and code rail, with Cloudflare
  notices, Terraform, and tooling added.
- `src/layouts/` are the Nimbus page shells.
- `src/styles/globals.css` holds the Cloudflare palette as Nimbus `--nb-*`
  tokens; `src/styles/cloudflare.css` aliases them as the `--cf-*` tokens.
- `src/sidebar-filter.ts` filters the sidebar as the reader types.
- Nimbus publishes agent discovery files at the origin root and under `/api`;
  on a host shared with other sites they belong in the root site's files.

The published spec download is off: Nimbus pretty-prints it, and at 36 MB it is
over the Workers asset limit. MDX validation is off because the site has no
authored MDX pages.

### Styling

Files copied from Nimbus (`src/layouts/`, `src/components/ui/`, and
`src/styles/globals.css`) keep Nimbus's Tailwind classes so starter updates
still apply. Everything else uses scoped or plain CSS with the `--cf-*` and
`--nb-*` tokens. Do not put utility classes on markup that repeats at scale: the
API sidebar renders thousands of rows per page, and per-row class strings
multiply page size.

## Terraform

Each operation lists the Terraform resources and data sources that call it. The
data is `src/generated/terraform-docs.json`, which `pnpm generate:terraform-docs`,
run from the repository root, writes with the generator from the
`cloudflare-terraform-docs` package (see its README for the sources it reads).
`.github/workflows/sync-terraform-docs.yml` keeps it current.

The site renders it with:

- `src/terraform-extension.ts`: the `astro-fern` extension that attaches
  declarations to operations and renders their Markdown descriptions with
  `src/description-markdown.ts`;
- `src/terraform.ts`: operation data, endpoint matching, and declaration labels;
- `src/forge-api.ts`: copies the data to `x-cloudflare-terraform` and turns each
  declaration example into the Terraform request sample;
- `TerraformDeclarations.astro` and `TerraformFields.astro`, drawn by
  `ApiBody.astro` in an operation's Terraform view (`?lang=terraform`), where
  they take the place of the HTTP reference, as on `main`. Every operation page
  carries both, and CSS shows the one that matches the code rail's sample, so
  switching never reloads the page. `terraform-section.client.ts` keeps
  Terraform out of the saved sample and `?lang=terraform` on links while the
  reader is in that view.

This is temporary: the provider is generated by Stainless. Once Forge supports
Terraform natively, remove it:

1. Delete `packages/cloudflare-terraform-docs`,
   `.github/workflows/sync-terraform-docs.yml` and the root `package.json`'s
   `generate:terraform-docs` script.
   Remove its entry from the root `AGENTS.md`.
2. Here, delete `src/generated/`, `src/terraform.ts`, `src/terraform.test.ts`,
   `src/terraform-extension.ts`, `src/description-markdown.ts` and its test,
   `src/components/TerraformDeclarations.astro`,
   `src/components/TerraformFields.astro`, and
   `src/components/ui/api-layout/terraform-section.client.ts`.
3. Remove their uses:
   - the extension, `x-cloudflare-terraform`, and the Terraform samples in
     `src/forge-api.ts`, and their cases in `src/forge-api.test.ts`;
   - the Terraform view and the `terraform-section.client` import in
     `ApiBody.astro`, with its `data-api-http-ref` wrapper and the CSS that
     switches between them;
   - the `x-cloudflare-terraform` entry and the `terraform.ts` import in
     `src/nimbus-api.d.ts`;
   - the `renderDescription` fixture in `src/plain-text.test.ts`;
   - the Terraform checks in `e2e/site.e2e.ts` and the `operation-terraform`
     shot in `e2e/visual.e2e.ts`.
4. Decide on the `terraform` target in `src/cloudflare.ts`: drop it with its
   case in `src/cloudflare.test.ts`, or keep it for Forge's own Terraform
   samples. Kept without samples, every operation shows a placeholder.
5. Remove `satteri` and `hast-util-sanitize` from `package.json`, and
   `packages/cloudflare-api-site/src/generated` from `.oxfmtrc.json`.
6. Run `pnpm install`, then `test`, `check`, and `test:e2e`.

## Routes

API pages render on request under `/api/`. Products, resources, and
operations follow the Fern SDK hierarchy:

```text
/api/zero-trust/
/api/zero-trust/devices/ip-profiles/
/api/zero-trust/devices/ip-profiles/methods/list/
```

`?version=<id>` selects an API version; omitting it selects the default. The
current build has one version, and the version picker still shows it.

Agent routes:

```text
/api/llms.txt
/api/zero-trust/llms.txt
/api/llms-full.txt
/api/zero-trust/devices/ip-profiles/methods/list/index.md
```

## Run it

From the repository root after `pnpm install`:

```bash
pnpm --filter cloudflare-api-site dev             # cf dev
pnpm --filter cloudflare-api-site check
pnpm --filter cloudflare-api-site test            # unit tests
pnpm --filter cloudflare-api-site test:e2e        # serves the last build
pnpm --filter cloudflare-api-site build           # cf build
pnpm --filter cloudflare-api-site preview         # serve the last build locally
pnpm --filter cloudflare-api-site deploy          # cf deploy
pnpm --filter cloudflare-api-site deploy:preview  # cf previews deploy
```

The Worker is configured in `cloudflare.config.ts` and built and deployed with
the [Cloudflare CLI](https://developers.cloudflare.com/cf/) (`cf`). `cf build`
runs `astro build` and writes Build Output to `.cloudflare/output/v0/`.
`cf previews deploy` deploys a Worker Preview named after the current branch,
served at `<preview-name>-docs.<subdomain>.workers.dev` (`previewUrls` in
`cloudflare.config.ts`).
`.github/workflows/preview-docs.yml` deploys one for every same-repository pull
request and comments its URL. `.github/workflows/deploy-docs.yml` deploys the
site; see [API versions](#api-versions) for its triggers.

Build-time environment variables:

- `FORGE_OPENAPI_RELEASE`: a release tag such as `openapi@<api-schemas-commit>`,
  to build against `openapi.json` at that `api-schemas` commit. It goes away
  once the site reads every version from the index.
- `FORGE_OPENAPI_SPEC`: an already-downloaded spec, to build without
  downloading it again, for example the rolling spec `materialize` writes (see
  [API versions](#api-versions)):

  ```bash
  pnpm --filter cloudflare-api-site api-versions materialize --out .forge/sources
  FORGE_OPENAPI_SPEC=.forge/sources/rolling.json pnpm --filter cloudflare-api-site build
  ```

- `INTERNAL_SITE_DOMAIN`: an internal deployment's hostname. Astro trusts the
  `X-Forwarded-Host` header only for hosts in
  [`security.allowedDomains`](https://docs.astro.build/en/reference/configuration-reference/#securityalloweddomains):
  one subdomain level of `cloudflare.com` and any subdomain of `cloudflare.dev`,
  over HTTPS. This adds the internal host.

`test:visual` compares screenshots of key pages against local baselines. It
serves the last build with `astro preview`, or uses `VISUAL_BASE_URL` when set.
Build the known-good revision and run it with `--update-snapshots` to record
baselines, then build the change and run it again. Build both against the same
`FORGE_OPENAPI_SPEC`; baselines and results are not committed.

## API versions

The site publishes two kinds of API version:

- **Rolling**, the latest: `openapi.json` at the head of `cloudflare/api-schemas`
  `main` when the site builds. It is the default and is never recorded.
- **Snapshots**, one per API release. A release is a GitHub Release of
  `cloudflare/api-schemas` named after its version, `YYYY-MM-DD.<train>` (for
  example `2026-10-01.epoch`). Release candidates (`-rcN`) and `.rolling` are
  never published there.

`api-versions.json` records the snapshots, oldest first, each pinned to the
commit its release pointed at and the SHA-256 of its spec:

```json
{ "id": "2026-10-01.epoch", "commit": "<40-character sha>", "sha256": "<64-character digest>" }
```

The record is append-only. Sync adds releases, fails if a recorded release now
points at another commit, and keeps one that disappeared upstream with a
warning. Changing or removing an entry is a reviewed edit to the file.

`scripts/api-versions.ts` reads and writes it:

```bash
pnpm --filter cloudflare-api-site api-versions sync         # record new upstream releases
pnpm --filter cloudflare-api-site api-versions materialize --out .forge/sources [--rolling-commit <sha>] [--cache <dir>]
```

`materialize` writes every snapshot spec, checked against its digest, the
rolling spec, and `index.json`, which lists them all. Until the site reads that
index, a build renders rolling alone, from `FORGE_OPENAPI_SPEC`.

The workflows:

- `.github/workflows/deploy-docs.yml` deploys on a push to `main`, on the
  `api-schemas-updated` dispatch that `api-schemas` sends on every push to its
  `main`, and by hand. It never runs on a schedule, and runs queue rather than
  cancel. A manual run can pin rolling to a commit, or build without deploying.
- `.github/workflows/sync-api-versions.yml` runs `sync` on the
  `api-schemas-released` dispatch, hourly, and by hand. When it records a
  release, it opens a pull request, which CI builds and the docs bot merges
  once every check passes. The merge deploys.
- `.github/actions/materialize-api-versions` runs `materialize` for the deploy,
  CI, and preview workflows, and caches snapshot specs between runs.
- `upstream/api-schemas-notify-docs.yml` is the workflow that sends both
  dispatches. It belongs in `cloudflare/api-schemas`, not here.

The dispatches need `FORGE_DISPATCH_TOKEN` in `api-schemas`, and sync needs
`DOCS_SYNC_TOKEN` here. Both are fine-grained tokens of the docs bot, scoped to
this repository.
