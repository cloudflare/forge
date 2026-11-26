# cloudflare-api-site

Cloudflare's deployable API reference, built with Astro,
[Nimbus](https://nimbus-docs.com), and Forge.

Nimbus renders the API pages, their Markdown twins, and `llms.txt`. Forge,
through `@cloudflare/forge`, reads the OpenAPI spec at build time and decides
products, resources, and operation URLs. `src/forge-api.ts` applies what Forge
read to the spec Nimbus renders. It adds Cloudflare data to the spec and never
renders anything itself.

## Data flow

```text
openapi.forge.json (latest stable Forge release)
   Nimbus URL source, .nimbus/sources/forge/
                 |
                 v
   prepareForgeSpec (src/forge-api.ts), Nimbus's transform
   readContent (src/forge-content.ts), with Forge: products, resources,
   routes, aliases, samples, Terraform data
                 |
                 v
   prepareForgeApi (src/forge-api.ts)  <-  src/stainless-redirects.json
                                       <-  src/stainless-snippets.json
                 |
                 v
   .nimbus/api-specs/  the prepared spec
   .forge/             products, redirects, Stainless redirects
                 |
                 v
   Nimbus api pages
   /     |        \
 pages  Markdown  llms.txt
```

The spec is the `openapi.forge.json` asset on the latest stable Forge GitHub
release. `src/openapi-source.ts` declares it as a Nimbus URL source, which
Nimbus saves under `.nimbus/sources/forge/` and checks with one conditional
request on each build, downloading it only when it changed. Forge reads its
`x-forge-group-name` and `x-forge-method-name` metadata directly: a top-level
group is a product, the groups below it are the resource hierarchy, and the
method's name ends the route. OpenAPI tags remain internal ownership
metadata and do not appear in URLs.

`prepareForgeSpec` is the API's transform: Nimbus runs it in Node at each
build, dev start and `astro sync`, never in the Worker, and `astro preview`
reuses the last build's result.

It returns the spec Nimbus renders, with Cloudflare titles, each page's URL as
`x-nimbus-route` (on a moved product's tag, its new segment), `x-nimbus-order`
for lifecycle order, request samples (the SDK ones from the retired Stainless
site, see [Stainless snippets](#stainless-snippets)), synthesized response
examples, and Terraform data under `x-cloudflare-terraform`. Nimbus reads the
URLs from it, so the config carries no route map. It also writes these files to
the git-ignored `.forge/` directory:

- `products.json`: the products and their slugs, read by the command sidebar;
- `redirects.json`: old section, alias-operation, and moved-product URLs, read by
  `src/middleware.ts`;
- `stainless-lookup.json` and `stainless-fallbacks.json`:
  the retired Stainless site's redirects (see [Stainless redirects](#stainless-redirects)).

Operations with removed Forge metadata (`x-forge-sunset`, or an `x-forge-params`
override with a `flagName`) are left out, and so are operations Forge makes no
method of. An operation without an `operationId` gets its SDK address as one,
such as `zero-trust.access.applications.list`, with a product Nimbus keeps
renamed as its URL is (`tags.…` becomes `tagging.…`). Each alias of an
operation redirects to the operation's page.

Forge rejects a spec in which two methods share a group and a name, and the
build fails with its message. Such a collision is a bug in the spec.

## Project ownership

- `astro.config.mjs` installs Nimbus with the spec source, the API entry from
  `forgeApi()`, its transform `prepareForgeSpec`, and the Cloudflare adapter. API pages render on request. It lists the icons the site
  uses, so only those reach the Worker; add an icon there before using it.
- `src/forge-content.ts` reads the spec with Forge, and `src/forge-api.ts`
  prepares the spec from what it read, as
  above. `src/cloudflare.ts` holds the execution targets, snippets, and routing
  preferences it uses, and `src/version.ts` the API version.
- `src/content.config.ts` registers the `cf` command catalog. The API needs no
  collection: with `bundle: false`, Nimbus prepares its pages and reads them
  itself.
- `src/pages/[...slug].astro` renders every API page with Nimbus's
  `getApiRoute`; `src/plain-text.ts` turns a description into its meta
  description.
- `src/pages/[...slug]/index.md.ts`, `llms.txt.ts`, `[...section]/llms.txt.ts`,
  and `llms-full.txt.ts` are Nimbus's agent routes. A Markdown twin lives at
  `/<page>/index.md`; `[...slug].md.ts` 301s the old `/<page>.md` URLs to it.
  Its frontmatter leaves out the description, which the body repeats.
- `src/pages/search-manifest.json.ts` prerenders `/api/search-manifest.json`,
  the records a search index loads: `src/search-manifest.ts` turns each
  product, resource, and operation page of Nimbus's API model into one.
- `src/middleware.ts` 302s the URLs in `.forge/redirects.json` to their pages,
  and 301s the retired Stainless site's URLs.
- `src/stainless-redirects.ts` plans the Stainless redirects and resolves them
  per request.
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
over the Workers asset limit. The coordinate manifest
(`/nimbus-api/coordinates.json`) is off too: nothing cites this site's
operations yet. MDX validation is off because the site has no authored MDX
pages.

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

- `src/terraform-extension.ts`: looks up each operation's declarations by HTTP
  method and path, and renders their Markdown descriptions with
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
     shot in `e2e/visual.e2e.ts`;
   - `?lang=terraform` on the retired Stainless site's `/terraform/` redirects in
     `stainlessRedirect` (`src/stainless-redirects.ts`), and in its test and
     e2e cases, if the view goes: the old Terraform pages then fold onto the HTTP
     ones.
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

## Stainless redirects

The site replaces the Stainless API reference once served at these paths. Its
URLs 301 to today's pages. What it served is a committed snapshot,
`src/stainless-redirects.json`: each method page with its operationId, each
resource and model page, and every operationId it knew, all in the HTTP form and
collection-relative. The repository root's `pnpm generate:stainless-redirects`
writes it from the old site's source, by hand; the `cloudflare-stainless-site`
package's README says how to run it.

Each build resolves the snapshot against today's pages with
`planStainlessRedirects`:

- a method page goes to its operation's page;
- a resource page goes to the deepest section holding its methods, within the
  product that holds most of them;
- a model page goes to its resource's target;
- `/operations/<operationId>/` goes to its operation's page.

A page with no counterpart today goes to its nearest old ancestor's target, or
the home page. The build warns with their count and lists them in
`.forge/stainless-fallbacks.json`.

`src/middleware.ts` serves them with `stainlessRedirect`:

- each old page and its Markdown twin (`index.md`);
- its language variants (`/api/typescript/`, `/api/python/`, `/api/go/`,
  `/api/terraform/`), which open the page with that language's sample
  (`?lang=python`), and Terraform's in its view. The old `/api/node/` pages
  were TypeScript's, and open with `?lang=typescript`.

Old paths the snapshot doesn't hold were never pages, and they 404. The
redirects don't use `_redirects`: it allows only 2,000 static rules, and it
counts every rule after the first dynamic one as dynamic, against a limit of 100.

## Stainless snippets

The TypeScript, Python and Go samples are the retired Stainless site's, in
`src/stainless-snippets.json`: each old method page, as the redirects snapshot
names it, with its snippet per language. The repository root's
`pnpm generate:stainless-snippets` writes it; the `cloudflare-stainless-site`
package's README says how to run it.

Each build gives an operation the snippets of the old method page the snapshot
maps to its operationId, the page that redirects to it. When several old pages
map to one operation, such as account and zone variants, the first by path
wins, and the build warns with their count. An operation with no old page, or
whose page had no snippet in a language, shows a comment in that language
saying the SDK lacks it (`// This operation is not available in the Go SDK.`).

`src/stainless-snippets.ts` reads the file and maps it, and `prepareForgeApi`
adds the samples to `x-codeSamples`. The `typescript`, `python` and `go` targets
in `src/cloudflare.ts` render nothing themselves.

Once Forge generates its own SDK samples, remove these:

1. Delete the root `package.json`'s `generate:stainless-snippets` script, and in
   `packages/cloudflare-stainless-site` the snippets generator
   (`scripts/generate-stainless-snippets.ts`, `scripts/snippets.ts` and its test,
   and the `generate:snippets` script). Delete the whole package if the
   redirects are retired too.
2. Here, delete `src/stainless-snippets.json`, `src/stainless-snippets.ts` and its
   test, and in `src/forge-api.ts` the `sdkSnippets` parameter of
   `prepareForgeApi`, `readStainlessSnippets`, `sdkPlaceholder` and
   `isStainlessLanguage`, with their cases in `src/forge-api.test.ts`.
3. Point the `typescript`, `python` and `go` renderers in `src/cloudflare.ts` at
   Forge's samples, and drop the SDK samples test in `e2e/site.e2e.ts` if they
   change.

## Run it

From the repository root after `pnpm install`, build `@cloudflare/forge`,
which the site reads the spec with. Its build compiles forge to WebAssembly,
so it needs the Rust toolchain that `rust-toolchain.toml` pins:

```bash
pnpm --filter @cloudflare/forge build
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
site on every push to `main`, on each stable Forge release that carries
`openapi.forge.json`, and on manual dispatch.

Build-time environment variables:

- `FORGE_OPENAPI_RELEASE`: a release tag such as `openapi@<api-schemas-commit>`,
  to build against that exact spec, as a release-triggered deploy does.
- `FORGE_OPENAPI_SPEC`: a spec file, to build from it instead of a release.
- `INTERNAL_SITE_DOMAIN`: an internal deployment's hostname. Astro trusts the
  `X-Forwarded-Host` header only for hosts in
  [`security.allowedDomains`](https://docs.astro.build/en/reference/configuration-reference/#securityalloweddomains):
  one subdomain level of `cloudflare.com` and any subdomain of `cloudflare.dev`,
  over HTTPS. This adds the internal host.

`test:visual` compares screenshots of key pages against local baselines. It
serves the last build with `astro preview`, or uses `VISUAL_BASE_URL` when set.
Build the known-good revision and run it with `--update-snapshots` to record
baselines, then build the change and run it again. Pin `FORGE_OPENAPI_RELEASE`
for both builds; baselines and results are not committed.
