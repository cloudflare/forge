# The Forge docs site

Astro, with [Nimbus](https://nimbus-docs.com) (`@cloudflare/nimbus-docs`) as the docs framework. The
package handles content schemas, sidebar and TOC, MDX to markdown, search, OG cards, `llms.txt`,
build hooks, and the `nimbus-docs` CLI. The files in `src/` outside `src/content/` are Nimbus's
starter, kept as Nimbus writes them; the README lists the few the site changes, and why.

`README.md` next to this file explains how the site looks and why.

## Working in here

This package is part of the repo pnpm workspace. Install once at the repo root:

```sh
pnpm install
pnpm --filter forge-docs dev          # http://localhost:4321
pnpm --filter forge-docs build        # cf build, then nimbus-docs lint; output in ./.cloudflare/output
pnpm --filter forge-docs check        # astro check: types, content collections
pnpm --filter forge-docs lint:docs
pnpm --filter forge-docs run deploy   # build, then cf deploy
```

The site deploys with the [`cf` CLI](https://developers.cloudflare.com/cf/), from
`cloudflare.config.ts`: a Worker with no script, serving the prerendered pages as static assets.
`cf` builds Astro through the Cloudflare adapter, so `astro.config.ts` has the adapter even though
every page is prerendered. Workers Builds previews every branch and deploys `main`; the README has
the details.

## File layout

```text
astro.config.ts              # nimbus(defineNimbusConfig({...})): sidebar, lint rules, markdown plugins
nimbus.json                  # what the scaffold and the registry installed. Committed.
.nimbus/                     # build scratch. Gitignored.
src/
├── components.ts            # MDX globals registry: every component used in .mdx must be listed
├── components/              # Nimbus's, except Logo.astro and logo.ts, which are the site's lockup
│   └── ui/<slug>/           # from the Nimbus starter and registry
├── content/docs/**/*.mdx    # the pages, one directory per sidebar group
├── content/partials/        # partials for <Render file="..." />; none yet
├── content.config.ts
├── layouts/                 # BaseLayout (head, theme bootstrap), DocsLayout (three columns)
├── lib/                     # cn.ts and the starter's helpers
├── pages/                   # [...slug].astro, 404, llms.txt, robots.txt, og/ (_card.ts is the card's look)
└── styles/                  # globals.css (tokens and shell), prose.css
public/                      # favicon, _headers
cloudflare.config.ts         # the Worker cf deploys: assets only
```

## Writing docs

Frontmatter validates against Nimbus's `docsSchema`. `title` and `content_type` are required. Sidebar
groups are declared in `astro.config.ts`; position within a group comes from `sidebar.order`:

```mdx
---
title: My page
description: One-line summary.
content_type: concept
sidebar:
  order: 3
---

Content here. The H1 comes from `title`; don't repeat it in the body.
```

Rules:

- **Follow the [Cloudflare docs style guide](https://developers.cloudflare.com/style-guide/).**
  Every page has one of its
  [content types](https://developers.cloudflare.com/style-guide/documentation-content-strategy/content-types/)
  in `content_type`, and follows that type's rules for its title and shape:

  | `content_type`    | Title                                | Shape                                                    |
  | ----------------- | ------------------------------------ | -------------------------------------------------------- |
  | `overview`        | The product's name                   | One orienting paragraph, then links onward               |
  | `get-started`     | Get started                          | Prerequisites, numbered steps, a check of the result     |
  | `how-to`          | An imperative verb phrase, no gerund | Steps, then how to verify the result                     |
  | `concept`         | A noun phrase                        | Prose that explains; no steps                            |
  | `reference`       | The surface's name                   | Every entry, uniformly; a table first if readers scan it |
  | `troubleshooting` | Troubleshooting, then the area       | Each error or symptom, its cause and its fix             |

  Every page but an overview ends with **Related resources**, linking the pages the style guide's
  [cross-linking table](https://developers.cloudflare.com/style-guide/style-and-grammar/formatting/structure/links/#cross-linking-requirements)
  asks for. Get-started and how-to pages then end with **Next steps**, for onward tasks only. In
  prose: no contractions, no semicolons (split the sentence), and "refer to" rather than "see" before
  a link.

- **Every claim is checked against the source.** The pages describe Forge's behaviour precisely:
  which errors, which order, which defaults. Read the Rust doc comments (`src/lib.rs`,
  `src/types.rs`, `src/method.rs`, `src/link.rs`) or run `forge` on a small document before writing
  one. Output shown on a page is real output.
- **Every internal link must resolve.** `nimbus/internal-link` is an error, so a broken link fails
  `pnpm build`, which lints the pages after building them. It does not check `#anchors`; check
  those against the built HTML.
- **Quote a `description` that contains `: `.** YAML reads it as a mapping otherwise, and the build
  fails.
- **Components must be PascalCase and registered in `src/components.ts`.**
- **Partials use `<Render file="..." />`.** Don't import `.mdx` directly.
- **Nimbus's components first.** Use what the starter and registry have (`Aside`, `CardGrid`,
  `LinkCard`, `Steps`, `Tabs`, `PackageManagers`, and the rest from `nimbus-docs add`). A site
  component needs a reason no Nimbus component meets, written in the README's table of changes.
- **Commands are `<PackageManagers>`.** Never hard-code `npm install` or `npx`.
- **Don't remove `<AgentDirective />` from `BaseLayout.astro`.** It points agents at `/llms.txt`.

- **Other generators live under Compatibility Modes.** Forge's own conventions (methods named by a
  dotted `operationId`, models by schema name, fields by wire name) are what every page describes.
  Extensions that Forge reads for compatibility with another generator are described only on that
  generator's page in `src/content/docs/compatibility/`, and no other page, component or file in
  this package names that generator. Elsewhere, say "a compatibility mode" and point at the sidebar
  group. Check with a case-insensitive grep for the generator's name before finishing.

House style: no em dashes, and no `--` either, since it renders as two hyphens; every code fence
gets a language; no code block directly under a heading, so say what it is first. Plugins are
first-class: when a page describes a built-in target, say that it is a plugin like any other.

## Public content

This site is public. Never mention internal repositories, hosts, tickets or links in it. Describe
internal work in generic terms.

## Adding things

| Goal                 | Action                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------- |
| New doc page         | `src/content/docs/<group>/<slug>.mdx`, with `sidebar.order`. The group autogenerates.       |
| New sidebar group    | A directory under `src/content/docs/` and an entry in `astro.config.ts`.                    |
| UI from the registry | `pnpm exec nimbus-docs add <slug>`, then register it in `src/components.ts` if MDX uses it. |
| OG card restyle      | `src/pages/og/_card.ts`.                                                                    |
| Check it builds      | `pnpm build`: it builds the site, then lints every page, including its internal links.      |

Files under `src/` outside `src/content/` are Nimbus's, byte for byte, except the changes listed
in the README. To update Nimbus, copy the new starter over them and reapply those changes; Forge's
formatter skips `src/` so the diff stays readable.

## Don't

- Change a Nimbus file without adding a row to the README's table of changes.
- Spend `--nb-brand` on anything but where you are and what you can act on. Prose links are ink.
- Recolour the logo. Its two oranges are the Cloudflare mark's own, in `logo.ts` and the favicon.
- Hand-add a component under `src/components/ui/` that the registry has. Use `nimbus-docs add`.
- Attach remark or rehype plugins via `mdx({ remarkPlugins })`: they are silently dropped. Markdown
  transformations go in `markdown.mdastPlugins` and `hastPlugins`.
