# Forge docs

The documentation site for Forge, built with Astro and [Nimbus](https://nimbus-docs.com).

```sh
pnpm install                        # at the repository root
pnpm --filter forge-docs dev        # http://localhost:4321
pnpm --filter forge-docs build      # static output in ./dist
```

## How it looks, and why

The site is a Nimbus site with as few changes as possible. Every file under `src/` outside
`src/content/` is Nimbus's starter, as `create-nimbus-docs` writes it for the version in
`package.json`, so a Nimbus update is a copy and a diff. The changes, each for a reason:

| Change                          | Where                                                    | Why                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare orange as the brand  | `--nb-brand` in `src/styles/globals.css`                 | Darkened to 5:1 on white so it reads as text; Nimbus uses the brand only for where you are and what you can act on.                                                                                                                                                                                                                                                                                         |
| The logo                        | `src/components/logo.ts`, `Logo.astro`                   | Cloudflare's cloud in its own two colours, beside the word "Forge". `logo.ts` adds `fills`, which `src/pages/og/_card.ts` reads, so the social cards don't recolour the mark.                                                                                                                                                                                                                               |
| The page body's theme           | `src/styles/forge.css`, one import in `BaseLayout.astro` | Forge's own look, "Furnace": Nimbus's neutral surfaces on a white ground, a glow from the top and Space Grotesk headings in the content and its table of contents, with orange buttons in dark mode. Only `--nb-*` tokens scoped to those two regions. Two small rules outside them: a hovered sidebar row takes the current page's wash, and the contents mark the current section in Cloudflare's orange. |
| The sidebar filter stays put    | `src/layouts/DocsLayout.astro`                           | The filter sits in a sticky bar at the top of the tree, so it is in reach however far the sidebar scrolls. Worth reporting upstream.                                                                                                                                                                                                                                                                        |
| The "Updated" date              | `ui/page-actions/PageActions.astro`                      | Formatted in the site's locale and UTC, so a build doesn't depend on the machine it runs on.                                                                                                                                                                                                                                                                                                                |
| A minute of freshness for pages | `public/_headers`                                        | A hover-prefetched page can be reused on the click instead of fetched again.                                                                                                                                                                                                                                                                                                                                |

Add a row before adding a change. A change Nimbus should make itself is better reported upstream.

## Content

Pages are in `src/content/docs/`, one directory per sidebar group: start, concepts, plugins,
targets, openapi, compatibility, guides, reference. `AGENTS.md` has the rules for writing them; the most important
is that every statement about Forge is checked against its source or its output.

## Deployment

`wrangler.jsonc` serves `dist/` as static assets. It has no account or route yet; add both when the
site has a home, and build with `DOCS_SITE_URL` set to its origin.
