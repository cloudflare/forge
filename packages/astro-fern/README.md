# astro-fern

Build API documentation from OpenAPI documents in Astro.

`astro-fern` loads OpenAPI content, resolves schemas, builds a catalog, creates
operation artifacts, plans routes, and renders Markdown for agents. Your Astro
application supplies the HTML, theme, snippet renderers, and any application URL
policy.

## Package roles

| Package or application | Responsibility                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `astro-fern`           | OpenAPI loading, manifests, snapshots, snippets, catalogs, operation artifacts, route planning, and agent documents |
| `fern-forge`           | Validation and adaptation for Forge metadata through the `astro-fern` extension API                                 |
| Your Astro application | HTML, navigation, theme, snippet implementations, visibility policy, and optional custom URLs                       |

## Start an Astro site

The server setup uses these files:

| File                            | Purpose                                                             |
| ------------------------------- | ------------------------------------------------------------------- |
| `astro.config.mjs`              | Registers the integration, adapter, route policy, and agent options |
| `src/content.config.ts`         | Registers the `apiReference` catalog and supplies content policy    |
| `src/live.config.ts`            | Registers the `apiOperations` live collection                       |
| `src/env.d.ts`                  | Adds the `Astro.locals` types                                       |
| `src/pages/api/[...slug].astro` | Renders human operation pages under the configured Fern base        |

The server APIs locate the catalog and operation artifacts by collection name.
The catalog defaults to `apiReference`; register it under another key and pass
that key to `astroFern({ collection })` when the name must change. The
`apiOperations` live collection name is fixed.

### Configure Astro

The configuration below uses Astro's Node adapter. Set `SITE_URL` to the public
deployment origin in production. During local development, the integration
supplies an artifact fetcher through `Astro.locals`.

```js
// astro.config.mjs
import node from '@astrojs/node';
import astroFern from 'astro-fern';
import { defineConfig } from 'astro/config';

const site = process.env.SITE_URL;

export default defineConfig({
  ...(site ? { site } : {}),
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [
    astroFern({
      routing: { base: '/api', target: 'path' },
    }),
  ],
});
```

`astro.config` and `content.config` run in separate module graphs. Runtime route
options belong in `astro.config`; OpenAPI sources and content policy belong in
`content.config`.

### Register content

```ts
// src/content.config.ts
import { defineFernManifest, type FernContentOptions } from 'astro-fern';
import { fernCollection } from 'astro-fern/collections';

const manifest = defineFernManifest({
  targets: [{ id: 'curl', kind: 'http', label: 'curl', language: 'bash' }],
  products: [
    {
      id: 'dns',
      pathPrefixes: ['/zones'],
      sections: [{ id: 'records', tag: 'DNS Records', title: 'DNS records' }],
    },
  ],
});

export const collections = {
  apiReference: fernCollection({
    source: new URL('./openapi.json', import.meta.url),
    manifest,
  } satisfies FernContentOptions),
};
```

Place operations tagged `DNS Records` in `src/openapi.json`. Operations under
`/zones` belong to the `dns` product.

### Register operation loading

```ts
// src/live.config.ts
import { defineLiveCollection } from 'astro:content';
import { fernOperationLiveLoader } from 'astro-fern/live';

export const collections = {
  apiOperations: defineLiveCollection({
    loader: fernOperationLiveLoader(),
  }),
};
```

### Add local types

```ts
// src/env.d.ts
/// <reference types="astro/client" />
/// <reference types="astro-fern/locals" />
```

### Render an operation

The integration plans operation paths. Your catchall page loads the selected
operation and renders its HTML.

```astro
---
// src/pages/api/[...slug].astro
import { getFernPageForPath } from 'astro-fern/server';

export const prerender = false;

const fetcher = Astro.locals.fernArtifactFetcher;
const resolved = await getFernPageForPath(Astro.url.pathname, {
  ...(Astro.locals.fernRequestCache
    ? { cache: Astro.locals.fernRequestCache }
    : {}),
  ...(fetcher ? { request: Astro.request, fetcher } : {}),
});

if (!resolved) return new Response('Not found', { status: 404 });

const { page, target } = resolved;
---

<main>
  <p>{page.operation.httpMethod} {page.operation.path}</p>
  <h1>{page.operation.title}</h1>
  <div set:html={page.operation.description.html} />

  <nav aria-label="Code examples">
    {
      page.targets.map((item) => (
        <a href={item.href} aria-current={item.id === target ? 'page' : undefined}>
          {item.label}
        </a>
      ))
    }
  </nav>
</main>
```

The integration also injects operation Markdown and `llms.txt` routes. Human
product pages, section pages, and navigation belong to the Astro application.

## Supply OpenAPI content

`fernCollection()` accepts one source or an explicit snapshot registry.
Each source resolves to a parsed OpenAPI object or a local JSON file.

| Input                             | Example                                              | Behavior                                         |
| --------------------------------- | ---------------------------------------------------- | ------------------------------------------------ |
| Parsed object                     | `source: document`                                   | Validated directly                               |
| Path relative to the project root | `source: './src/openapi.json'`                       | Read as JSON and watched                         |
| Local `file:` URL                 | `source: new URL('./openapi.json', import.meta.url)` | Read as JSON and watched                         |
| Provider                          | `source: async () => document`                       | Awaited during content loading                   |
| Remote HTTP source                | `source: async () => fetchAndParse()`                | The provider fetches and returns a parsed object |
| YAML source                       | `source: async () => parseYaml()`                    | The provider parses YAML and returns an object   |

A direct filesystem path or `file:` URL is read with the JSON loader. Fetch
remote documents inside a provider:

```ts
const source = async () => {
  const response = await fetch('https://example.com/openapi.json');
  if (!response.ok) {
    throw new Error(`OpenAPI request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
};
```

Files resolved through a provider are opaque to Astro's file watcher. Restart
the content load when those files change. If several snapshots reference the
same provider function, the loader calls it once for that content load and
compiles each snapshot from the returned source.

Every source is validated against the OpenAPI fields consumed by `astro-fern`.
Unknown OpenAPI and extension fields stay on the source object for extensions to
read.

## Define products and sections

The manifest gives stable identities to navigation and routes.

```ts
const manifest = defineFernManifest({
  targets: [curlTarget],
  products: [
    {
      id: 'dns',
      title: 'DNS',
      description: 'Manage DNS records and settings.',
      sdkGroup: 'dns',
      pathPrefixes: ['/zones'],
      sections: [
        { id: 'records', tag: 'DNS Records', title: 'Records' },
        { id: 'settings', tag: 'DNS Settings', title: 'Settings' },
      ],
    },
  ],
});
```

Product ownership follows these rules:

1. A product with `sdkGroup` accepts operations whose first SDK group segment
   equals that value. Primary projections and extension SDK projections both
   participate. `sdkGroup` takes precedence over `pathPrefixes`.
2. A product without `sdkGroup` uses `pathPrefixes` when they are present.
3. A product without either selector can accept any operation assigned to one of
   its sections.
4. A section accepts an operation when any OpenAPI tag exactly matches the
   section `tag`. Matching more than one configured section in a product is an
   error.
5. An operation can appear in more than one product when every matching product
   declares `sdkGroup`. Matches across products that use `pathPrefixes` or no
   product selector are ambiguous and fail generation.

For a product with `sdkGroup`, `x-fern-sdk-group-name` selects the product and its
remaining segments form the resource route. `x-fern-sdk-method-name` forms the
final method segment after `/methods/` and supplies the snippet method. For a
product without `sdkGroup`, section IDs and `operationId` values form the
operation route instead.

| Value                     | Used for                                                                       |
| ------------------------- | ------------------------------------------------------------------------------ |
| Product `id`              | Semantic product identity; normalized to a lowercase kebab-case URL slug       |
| Snapshot `slug`           | URL segment for a nondefault snapshot                                          |
| Section `id`              | Ownership identity; also a URL segment when the product has no `sdkGroup`      |
| OpenAPI `operationId`     | Semantic operation identity; also the final URL segment without `sdkGroup`     |
| OpenAPI tag               | Section assignment and default section label                                   |
| Fern SDK group and method | SDK-product selection, resource and method URL segments, and snippet accessors |

Section IDs must use lowercase kebab case. `defineFernManifest()` validates
manifest identities, targets, sections, and ownership selector shapes. Content
generation validates operation ownership and route collisions. Duplicate routes
for products without `sdkGroup` fail generation. SDK route collisions generate a
page only for a sole highest-priority mapping. Resolved collisions are silent;
ties omit the route and emit a warning after every configured priority and
preference has been applied.

Applications can supply `operationRoutingPreference` as a secondary numeric
tie-breaker for SDK mappings with equal extension priority. The callback receives
the OpenAPI operation and path, product, projection placement, generated route,
and extension priority. Higher values win only when exactly one tied mapping has
that value.

### Discover a manifest

`discoverProducts()` derives product IDs from the first segment of Fern SDK
groups and derives sections from each operation's first tag. Extension SDK
projections participate in discovery.

```ts
import { defineFernManifest, type FernManifestProvider } from 'astro-fern';

const manifest: FernManifestProvider = (_defaultSource, { discoverProducts }) =>
  defineFernManifest({
    targets: [curlTarget],
    products: discoverProducts(),
  });
```

For a snapshot registry, discovery inspects every source. Historical products
and sections can therefore remain in the manifest even when the default source
no longer contains them.

### Apply visibility policy

`x-fern-ignore: true` removes an operation from generated content. Applications
can add another visibility rule through `isOperationHidden`:

```ts
fernCollection({
  source,
  manifest,
  isOperationHidden: (operation) => operation['x-internal'] === true,
});
```

The visibility callback runs after product ownership is resolved and before
schema and snippet generation.

## Add snippet renderers

`astro-fern` calls renderers supplied by the application. Its exports include
request example helpers. The application supplies each language renderer.

```ts
import { createSnippetProvider, interpolatePath } from 'astro-fern';

const snippets = createSnippetProvider({
  curl: {
    label: 'curl',
    syntax: 'bash',
    render: ({ op }) => `curl -X ${op.method.toUpperCase()} "https://api.example.com${interpolatePath(op.path)}"`,
  },
});
```

Pass the provider to `fernCollection()` and configure a target with the
same ID:

```ts
const curlTarget = {
  id: 'curl',
  kind: 'http',
  label: 'curl',
  language: 'bash',
} as const;

fernCollection({
  source,
  snippets,
  manifest: defineFernManifest({
    targets: [curlTarget],
    products,
  }),
});
```

The provider receives the HTTP method, path and query parameters, request body
representations, SDK accessor path, method name, and snapshot ID. Header and
cookie parameters are not supplied. A renderer that returns `null` or throws
produces `code: null` for that target. The application can show an unavailable
state without failing the content build.

Targets come from the first configured list in this order:

| Catalog location         | Target source order                                                               |
| ------------------------ | --------------------------------------------------------------------------------- |
| Product snapshot         | Snapshot targets, then product targets, then manifest targets, then an empty list |
| Global snapshot registry | Snapshot targets, then manifest targets, then an empty list                       |

The selected list replaces every list after it, including when the selected list
is empty.

The root module also exports `buildBodyExample()`, `interpolatePath()`,
`placeholderValue()`, and `toEnvVar()` for renderer implementations.

## Add snapshots

A snapshot represents one documented state of an API. Every snapshot has its own
source, identity, label, slug, default flag, and optional target override. The
project applies one manifest, extension set, formatter, visibility policy, and
snippet provider across the registry.

A single source creates one implicit snapshot:

```text
id: current
slug: current
label: Current
default: true
```

Use explicit snapshots when readers need documentation from several source
revisions:

```ts
export const collections = {
  apiReference: fernCollection({
    source: {
      kind: 'snapshots',
      snapshots: [
        {
          id: 'v1',
          label: 'Version 1',
          slug: 'v1',
          source: new URL('./openapi.v1.json', import.meta.url),
        },
        {
          id: 'v2',
          label: 'Version 2',
          slug: 'v2',
          default: true,
          source: new URL('./openapi.v2.json', import.meta.url),
        },
      ],
    },
    manifest,
    snippets,
  } satisfies FernContentOptions),
};
```

| Field     | Meaning                                                                            |
| --------- | ---------------------------------------------------------------------------------- |
| `id`      | Stable identity used by catalogs and loaders. Required and unique.                 |
| `source`  | Parsed OpenAPI object, local JSON source, or provider. Required.                   |
| `label`   | Text for selectors and headings. Defaults to `id`.                                 |
| `slug`    | Nonempty URL segment other than `.` or `..`. Defaults to `id`.                     |
| `default` | Serves this snapshot without its slug. The first snapshot is the fallback default. |
| `targets` | Replaces inherited targets for this snapshot.                                      |

Snapshot order becomes selector order. IDs remain semantic identities when a
slug differs. The engine preserves the configured order and treats each ID as
opaque.

Each snapshot is compiled from its own source. Products, sections, operations,
schemas, titles, and operation slugs may differ. A product appears only in the
snapshots that contain at least one visible operation assigned to it. The global
snapshot registry still includes every configured snapshot.

Historical documentation requires an OpenAPI source for each documented state.
Reusing a source preserves its OpenAPI operation fields and schemas. Snapshot
metadata, target overrides, and snippets can still differ because snippet
renderers receive the snapshot ID.

## Add an extension

Extensions validate source metadata, contribute serializable operation data,
create SDK projections, and promote shared presentation fields.

```ts
// src/fern/audience.ts
import { defineFernExtension } from 'astro-fern';
import { z } from 'astro/zod';

export const audienceExtension = defineFernExtension<{ audience: string }>({
  name: 'audience',
  schema: z.object({ audience: z.string() }),
  operation({ operation }) {
    const audience = operation['x-audience'];
    return typeof audience === 'string' ? { data: { audience } } : undefined;
  },
});
```

Register the shared descriptor in `content.config`:

```ts
import { audienceExtension } from './fern/audience.ts';

fernCollection({
  source,
  manifest,
  extensions: [audienceExtension],
});
```

`prepare(document, { logger })` can validate and index a complete source before
discovery and content generation. Its returned state stays within that snapshot
build. Hooks are synchronous. Extension names must match
`[a-z][a-z0-9-]*`, must be unique, and run in name order.

`operation(context, state)` can run during discovery and content generation, so
it should return the same result for the same source operation. It can return:

| Property       | Result                                                             |
| -------------- | ------------------------------------------------------------------ |
| `data`         | JSON data stored at `page.operation.extensions[extension.name]`    |
| `variants`     | Additional SDK projections used by discovery and product ownership |
| `presentation` | Confirmation and route-collision priority metadata                 |

Contribution data is parsed with the extension schema and must be serializable
as JSON before it enters an operation artifact. A variant's `name` forms part of
its projection identity and must remain stable across snapshots and source
reordering.

When SDK projections share a route, the candidate with the highest
`presentation.routingPriority` wins only if it is the sole candidate at that
priority. A tie omits the route and emits a build warning.

Read extension data from Astro application code through the virtual module:

```ts
import { getOperationExtensionData } from 'fern:virtual/extensions';
import { audienceExtension } from './fern/audience.ts';

const audience = getOperationExtensionData(page.operation, 'audience', audienceExtension.schema);
```

An extension package can augment `FernExtensionDataRegistry` so that registered
names receive inferred return types. See [`fern-forge`](../fern-forge/README.md)
for an extension that validates Forge metadata and contributes aliases.

## Read catalogs and pages

The content catalog keeps operation payloads out of Astro's eager content store.
Server APIs compose a complete page when a route requests one.

```text
contentCatalog.snapshots[]      complete configured snapshot registry
contentCatalog.products[]       products with their available snapshots
routePlan.catalog               mounted pages and public paths
page                            one loaded operation with schemas and snippets
```

| API                                              | Use                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| `getFernContentCatalog()`                        | Read the source catalog and artifact references for custom indexes      |
| `getFernRoutePlan()`                             | Read mounted catalogs, human routes, agent routes, and resolved options |
| `getFernCatalog()`                               | Read the mounted catalog portion of the route plan                      |
| `getFernPage(pageId, options)`                   | Load a complete page from an opaque page ID                             |
| `getFernPageForPath(pathname, options)`          | Resolve a human path planned by the package and load its page           |
| `getFernOperation(entryId, snapshotId, options)` | Load an exact operation artifact for direct artifact workflows          |
| `getFernRouteContext(pathname)`                  | Resolve product, snapshot, operation, target, and switch options        |
| `createFernRequestCache()`                       | Deduplicate operation and page loads during one server request          |
| `getFernStaticPaths()`                           | Build Astro static path entries for every planned human operation route |
| `getAgentRoutes()`                               | Read every planned Markdown and `llms.txt` route                        |
| `getAgentLinks(pageId, options)`                 | Load the agent links for one page                                       |
| `renderPageMarkdownPathnameResponse()`           | Render a planned operation Markdown pathname as a response              |
| `renderLlmsPathnameResponse()`                   | Render a planned `llms.txt` pathname as a response                      |

Use page IDs from the mounted catalog. They are opaque and include the selected
product and snapshot. `entryId` identifies one operation within one product and
remains stable across snapshots. A direct artifact lookup also requires
`snapshotId`.

`getFernStaticPaths()` reads only the route plan. Rendering those paths during
prerendering still requires an artifact transport available during the build.

Renderers use these page fields:

| Field             | Use                                                                           |
| ----------------- | ----------------------------------------------------------------------------- |
| `page.pathname`   | Canonical human operation path                                                |
| `page.product`    | Product identity, title, and description                                      |
| `page.section`    | Section identity, tag, and title                                              |
| `page.snapshot`   | Selected snapshot identity, label, and default flag                           |
| `page.operation`  | Method, path, descriptions, parameters, schemas, examples, and extension data |
| `page.targets`    | Target labels, links, syntax, package metadata, and generated code            |
| `page.agentLinks` | Planned Markdown and `llms.txt` links                                         |

Use `page.pathname`, target `href` values, agent links, route context, or a
semantic link resolver when building links. `page.snapshot.id` is an identity
and may differ from its URL slug.

Product and section landing pages can use `getFernCatalog()` without loading
operation artifacts.

## Configure human routes

`routing.base` defaults to `/api`. Astro's `base` is prepended to every Fern
human path, scoped agent path, and artifact URL. The site `llms.txt` lives at the
Astro base root.

For this configuration:

```js
export default defineConfig({
  base: '/docs',
  integrations: [
    astroFern({
      routing: { base: '/api', target: 'hash' },
    }),
  ],
});
```

the default snapshot operation path starts with `/docs/api/`, and the site index
is `/docs/llms.txt`.

### Hash targets

Hash routing is the default. One human document serves the aggregate operation
and every target selection:

```text
/api/dns/records/methods/list/
/api/dns/records/methods/list/#curl
/api/dns/records/methods/list/#typescript
```

The browser sends no hash to the server. Use `targetFromHash()` and
`targetHref()` from `astro-fern/runtime` in client code.

### Path targets

Path routing creates an aggregate operation path and one human path per target:

```text
/api/dns/records/methods/list/
/api/dns/curl/records/methods/list/
/api/dns/typescript/records/methods/list/
```

Choose path routing when each target needs an independently indexable human
document. Choose hash routing when target selection is interactive state within
one document.

A nondefault snapshot inserts its slug after the product:

```text
/api/dns/v1/records/methods/list/
/api/dns/v1/curl/records/methods/list/
```

The package plans operation routes. The application defines any product,
section, search, guide, or command pages.

## Publish agent documents

The integration can inject plain Markdown operation documents and nested
`llms.txt` indexes.

| Option                | Default             | Effect                                                                          |
| --------------------- | ------------------- | ------------------------------------------------------------------------------- |
| `agents.injectRoutes` | `true`              | Mounts the configured agent route handlers                                      |
| `agents.markdown`     | `true`              | Plans an aggregate Markdown document and one target document for each operation |
| `agents.llms`         | All scopes          | Plans indexes for selected `site`, `product`, `snapshot`, and `target` scopes   |
| `agents.directive`    | Default instruction | Prepends the supplied string to operation Markdown; `false` omits it            |

The built-in directive is:

```text
> This page is optimized for agents. Use the linked Markdown pages and llms.txt indexes for related API content.
```

Markdown target paths always use a target segment, including when human targets
use hashes:

```text
/api/dns/records/methods/list.md
/api/dns/curl/records/methods/list.md
/api/dns/v1/records/methods/list.md
/api/dns/v1/curl/records/methods/list.md
```

The aggregate document contains every configured target. A target document
contains the selected invocation.

`llms.txt` scopes use these paths:

| Scope      | Path                                                        | Contents                                  |
| ---------- | ----------------------------------------------------------- | ----------------------------------------- |
| `site`     | `/llms.txt`                                                 | Every product                             |
| `product`  | `/api/{product}/llms.txt`                                   | The product in the default snapshot       |
| `snapshot` | `/api/{product}[/{snapshotSlug}]/llms.txt`                  | One product snapshot                      |
| `target`   | `/api/{product}[/{snapshotSlug}]/targets/{target}/llms.txt` | Operations for one target in one snapshot |

When product and snapshot scopes are both enabled, the product index occupies the
default snapshot path. When only snapshot scope is enabled, the default snapshot
uses that path. A historical product with no default snapshot receives indexes
under its historical snapshot slugs.

### Mount planned routes in the application

Set `agents.injectRoutes: false` when the application will mount every planned
agent path. `getAgentRoutes()` returns the required paths. The pathname response
helpers resolve those paths and return 404 responses for unknown routes.

Mount the site index in `src/pages/llms.txt.ts` and scoped indexes in
`src/pages/api/[...scope]/llms.txt.ts`:

```ts
import { renderLlmsPathnameResponse } from 'astro-fern/server';

export const prerender = false;

export function GET({ url }: { url: URL }): Promise<Response> {
  return renderLlmsPathnameResponse(url.pathname);
}
```

Both files can use the same handler. Mount aggregate and target Markdown in
`src/pages/api/[...document].md.ts`:

```ts
import { renderPageMarkdownPathnameResponse } from 'astro-fern/server';

export const prerender = false;

export function GET({ locals, request, url }: { locals: App.Locals; request: Request; url: URL }): Promise<Response> {
  const fetcher = locals.fernArtifactFetcher;
  return renderPageMarkdownPathnameResponse(url.pathname, {
    ...(locals.fernRequestCache ? { cache: locals.fernRequestCache } : {}),
    ...(fetcher ? { request, fetcher } : {}),
  });
}
```

Mount the site index, scoped indexes, aggregate Markdown, and target Markdown
paths that are enabled. Planned links become reachable when their corresponding
handlers are mounted.

### Use application URLs

Applications can disable the package agent plans and render the same documents
under query parameters or another URL scheme:

```js
astroFern({
  routing: { base: '/' },
  agents: { injectRoutes: false, markdown: false, llms: false },
});
```

Use the catalog to select an opaque page ID, load the page, and supply a semantic
URL resolver:

```ts
import { renderLlmsIndexFromCatalog, renderPageMarkdown, type SemanticHrefResolver } from 'astro-fern/agents';
import { getFernContentCatalog, getFernPage, type FernOperationLoadOptions } from 'astro-fern/server';

export async function renderSelectedOperation(
  pageId: string,
  target: string | undefined,
  loadOptions: FernOperationLoadOptions,
  resolveHref: SemanticHrefResolver,
) {
  const page = await getFernPage(pageId, loadOptions);
  const operation = renderPageMarkdown(page, {
    ...(target ? { target } : {}),
    resolveHref,
  });
  const index = renderLlmsIndexFromCatalog(
    await getFernContentCatalog(),
    {
      kind: 'llms',
      scope: 'snapshot',
      productId: page.product.id,
      snapshotId: page.snapshot.id,
    },
    resolveHref,
  );
  return { operation, index };
}
```

Select `pageId` from `getFernRoutePlan().catalog`. The resolver maps semantic
operation and index identities to the application's URLs.

`renderPageMarkdown()`, `renderLlmsIndexFromCatalog()`, and
`renderLlmsIndex()` remain available for every agent configuration.

## Add a snapshot switcher

The integration middleware sets `Astro.locals.fern` for each request. Recognized
operation routes receive product, snapshot, operation, target, and switch data.

```ts
interface FernRouteContext {
  product?: string;
  snapshot?: string;
  operationId?: string;
  target?: string;
  snapshots: SnapshotSwitchOption[];
}

interface SnapshotSwitchOption {
  id: string;
  label: string;
  href: string;
  current: boolean;
  default: boolean;
}
```

Each switch option links to the same `operationId` in another snapshot. Snapshots
that lack the operation are omitted. A path target is preserved when the target
exists in the destination snapshot; otherwise the link uses the aggregate
operation path. Hash state is available only in the browser, so a client
component should preserve it when switching.

The package exports an unstyled Astro component:

```astro
---
import SnapshotSwitcher from 'astro-fern/components/SnapshotSwitcher.astro';
---

<SnapshotSwitcher label="API version" />
```

It renders anchor links inside `details` whenever at least one snapshot applies,
including a single-option selector, and renders no markup when none apply. Pass
`context` to override `Astro.locals.fern`. For custom markup, read the local
directly, call `getFernRouteContext()`, or call `buildSnapshotSwitch()` with a
route plan.

The ambient declaration adds these locals:

| Local                 | Use                                                      |
| --------------------- | -------------------------------------------------------- |
| `fern`                | Product, snapshot, operation, target, and switch context |
| `fernRequestCache`    | Deduplicates operation and page loads during one request |
| `fernArtifactFetcher` | Lets an adapter read generated public artifacts          |

## Process source Markdown

OpenAPI descriptions become `{ markdown, html }` values. The HTML is intended
for Astro's `set:html` directive.

With Astro's Satteri processor active, the integration installs an MDAST plugin
that turns source HTML nodes into text. It replaces complete link, image, and
definition URLs with `#` when their scheme is outside `http`, `https`, `mailto`,
and `tel`. The integration logs a warning when another Markdown processor is
active.

Only pass `page.operation.*.html` to `set:html` after a sanitizer has processed
it. The package provides that guarantee only when its Satteri plugin is active.
Add an equivalent sanitizer when another processor is active.

The plugin covers source nodes present when it runs. Markdown plugins that add
HTML or links later in the pipeline must enforce the same URL and HTML policy.
Agent documents contain source Markdown, so publish agent routes from trusted
OpenAPI content or apply an application content policy before generation.

## Deploy operation artifacts

Content loading writes the catalog to Astro's content store and writes operation
JSON under `public/_astro-fern/operations/`. It also writes catalog descriptors
under `public/_astro-fern/catalogs/`.

Complete these deployment steps:

1. Reserve `public/_astro-fern/` for package output and include it in deployed
   static assets. Cleanup removes files and directories the package does not
   recognize under this path.
2. Ignore generated artifact files in source control.
3. Give files named by their digest a long immutable cache lifetime.
4. Set `site` in Astro configuration to a trusted public origin, pass `origin` to
   a page loading helper, or supply a local platform asset binding.
5. Confirm that a server request can read an operation artifact from the deployed
   asset service.
6. Keep secrets out of OpenAPI fields, extension data, and snippet renderer
   output because operation artifacts are public. Snippet renderers must not
   copy credentials or tokens from the environment into generated code.

Example ignore rule:

```gitignore
public/_astro-fern/
```

For Astro `base: '/'`, an adapter cache policy can use this pattern. Adapt the
path and wildcard syntax for the deployment platform:

```text
/_astro-fern/*
  Cache-Control: public, max-age=31536000, immutable
```

Pass a platform asset service through the fetcher interface:

```ts
import { getFernPage, type FernRequestCache } from 'astro-fern/server';
import type { FernArtifactFetcher } from 'astro-fern/live';

export function loadPage(pageId: string, fetcher: FernArtifactFetcher, cache?: FernRequestCache) {
  return getFernPage(pageId, {
    origin: 'https://docs.example.com',
    fetcher,
    ...(cache ? { cache } : {}),
  });
}
```

Global `fetch` requires `origin` or Astro `site`. Request headers never select a
global network origin. Use `request: Astro.request` only with an asset binding
that resolves files locally. A fetcher that performs network requests must use
or enforce a fixed trusted origin. Assign a production asset binding to
`Astro.locals.fernArtifactFetcher` when Markdown routes injected by the package
need it.

### Artifact identities

An `entryId` identifies an operation within one product across snapshots. Moving
or assigning the same `operationId` to another product creates another `entryId`.
The pair `(snapshotId, entryId)` selects its content.
`artifactDigest` identifies the exact serialized bytes, and identical bytes share
one file.

The live loader verifies the SHA-256 digest, UTF-8 JSON, format, schema, and
semantic operation ID before returning data. When the previous revision is
known, catalog cleanup retains files for the active descriptor and its immediate
predecessor. Unknown revision history is preserved. Processes that build into
one `publicDir` need a single writer.

## Public modules

| Import                                         | Main exports                                                                                           | Intended use                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `astro-fern`                                   | `astroFern`, `defineFernManifest`, project builders, extension APIs, snippet APIs, route context types | Astro config and shared project configuration |
| `astro-fern/collections`                       | `fernCollection`                                                                                       | `src/content.config.ts`                       |
| `astro-fern/live`                              | `fernOperationLiveLoader`, `FernArtifactFetcher`                                                       | `src/live.config.ts` and artifact transports  |
| `astro-fern/server`                            | Catalog, page, route, cache, static path, and response helpers                                         | Astro server code                             |
| `astro-fern/agents`                            | `renderPageMarkdown`, `renderLlmsIndexFromCatalog`, `renderLlmsIndex`, semantic link types             | Agent document routes                         |
| `astro-fern/runtime`                           | `targetFromHash`, `targetHref`                                                                         | Browser target selection                      |
| `astro-fern/components/SnapshotSwitcher.astro` | Default `SnapshotSwitcher` component                                                                   | Astro page components                         |
| `astro-fern/locals`                            | Ambient `App.Locals` declarations                                                                      | `src/env.d.ts`                                |
| `astro-fern/content`                           | OpenAPI parsing, Docs Model builders, schemas, and content types                                       | Source and content tooling on the server      |

The root module and `astro-fern/content` include configuration or filesystem
code. Import browser helpers from `astro-fern/runtime`.
