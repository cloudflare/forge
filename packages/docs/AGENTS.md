# The Forge docs site

Astro, with [Nimbus](https://nimbus-docs.com) (`@cloudflare/nimbus-docs`) as the docs framework. The
package handles content schemas, sidebar and TOC, MDX to markdown, search, OG cards, `llms.txt`,
build hooks, and the `nimbus-docs` CLI. Everything in `src/` is a real file in this repo and yours to
edit, including the files the scaffold wrote.

`README.md` next to this file explains how the site looks and why.

## Working in here

This package is part of the repo pnpm workspace. Install once at the repo root:

```sh
pnpm install
pnpm --filter forge-docs dev      # http://localhost:4321
pnpm --filter forge-docs build    # static output in ./dist
pnpm --filter forge-docs check    # astro check: types, content collections
pnpm --filter forge-docs lint:docs
```

`wrangler.jsonc` serves `dist/` as static assets on a Worker, with no script. It has no account or
route yet.

## File layout

```text
astro.config.ts              # nimbus(defineNimbusConfig({...})): sidebar, lint rules, markdown plugins
nimbus.json                  # what the scaffold and the registry installed. Committed.
.nimbus/                     # build scratch. Gitignored.
fonts/                       # build-time only, for the OG cards. Not under public/ on purpose.
og-assets/                   # the mark drawn on OG cards
src/
├── components.ts            # MDX globals registry: every component used in .mdx must be listed
├── components/              # ours: Hero, PipelineFigure, Features, NavList, Logo, Header, Prose
│   └── ui/<slug>/           # from the Nimbus registry
├── content/docs/**/*.mdx    # the pages, one directory per sidebar group
├── content/partials/        # partials for <Render file="..." />; none yet
├── content.config.ts
├── layouts/                 # BaseLayout (head, theme bootstrap), DocsLayout (three columns)
├── lib/                     # cn.ts
├── pages/                   # [...slug].astro, 404, llms.txt, robots.txt, og/
└── styles/                  # globals.css (tokens and shell), prose.css
public/                      # favicon, _headers
wrangler.jsonc
```

## Writing docs

Frontmatter validates against Nimbus's `docsSchema`. `title` is required. Sidebar groups are declared
in `astro.config.ts`; position within a group comes from `sidebar.order`:

```mdx
---
title: My page
description: One-line summary.
sidebar:
  order: 3
---

Content here. The H1 comes from `title`; don't repeat it in the body.
```

Rules:

- **Every claim is checked against the source.** The pages describe Forge's behaviour precisely:
  which errors, which order, which defaults. Read the Rust doc comments (`src/lib.rs`,
  `src/types.rs`, `src/method.rs`, `src/link.rs`) or run `forge` on a small document before writing
  one. Output shown on a page is real output.
- **Every internal link must resolve.** `nimbus/internal-link` is an error, so a broken link fails
  the build. It does not check `#anchors`; check those against the built HTML.
- **Quote a `description` that contains `: `.** YAML reads it as a mapping otherwise, and the build
  fails.
- **Components must be PascalCase and registered in `src/components.ts`.**
- **Partials use `<Render file="..." />`.** Don't import `.mdx` directly.
- **A `mode: custom` page gets a bare `<main>`**, so its prose must be wrapped in `<Prose>`.
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
| OG card restyle      | `src/pages/og/_og-card-config.ts`.                                                          |
| Check it builds      | `pnpm exec nimbus-docs check --json`, then a build for link checking.                       |

Two registry components are modified, so `add --overwrite` will undo the changes:
`page-actions/PageActions.astro` (a `data-pagefind-ignore` on the actions, a fixed locale and time
zone for the "Updated" date, and the divider at `/70`, which keeps it above 3:1 in both schemes) and
`breadcrumbs/Breadcrumbs.astro` (separators that inherit `text-muted-foreground`, for contrast).

## Don't

- Spend the orange accent on anything but calls to action and the active state. Prose links are
  ink.
- Darken or theme-swap `--fg-orange`. It is Cloudflare orange, `#f6821f`, on both schemes. For
  orange text on a light background, use `--fg-orange-text`, which is readable.
- Dim text with `opacity`, or Tailwind's alpha modifier. `--nb-muted-foreground` is the measured
  secondary colour. The page-actions divider is the one measured exception.
- Recolour the logo. Its two oranges are the Cloudflare mark's own, in `Logo.astro`, the favicon and
  `og-assets/`.
- Hand-add a component under `src/components/ui/` that the registry has. Use `nimbus-docs add`.
- Attach remark or rehype plugins via `mdx({ remarkPlugins })`: they are silently dropped. Markdown
  transformations go in `markdown.mdastPlugins` and `hastPlugins`.
