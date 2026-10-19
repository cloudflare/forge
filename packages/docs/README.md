# Forge docs

The documentation site for Forge, built with Astro and [Nimbus](https://nimbus-docs.com).

```sh
pnpm install                        # at the repository root
pnpm --filter forge-docs dev        # http://localhost:4321
pnpm --filter forge-docs build      # static output in ./dist
```

## How it looks, and why

- **Cloudflare's palette, quietly.** Neutral greys carry the page. Cloudflare orange, `#f6821f`
  (`--fg-orange`), is spent on calls to action and the active state, and nothing else, so it keeps
  meaning "here". Orange text on light backgrounds uses `--fg-orange-text`, a darker orange, because
  the brand orange on white is too faint to read as text.
- **Both schemes are first-class.** The site follows the system setting and the toggle. Every token
  has a light and a dark value in `src/styles/globals.css`.
- **The logo is Cloudflare's mark**, in its own two oranges, in `src/components/Logo.astro`, the
  favicon, and the OG card mark in `og-assets/`.
- **Inter and JetBrains Mono**, self-hosted through Fontsource, so there are no font requests to a
  third party.
- **The landing figure is the argument.** `PipelineFigure.astro` shows the three stages (document,
  model, plugins) because that is what Forge is. It is markup, not an image, so it is searchable,
  selectable and themed.

## Content

Pages are in `src/content/docs/`, one directory per sidebar group: start, concepts, plugins,
targets, openapi, guides, reference. `AGENTS.md` has the rules for writing them; the most important
is that every statement about Forge is checked against its source or its output.

## Deployment

`wrangler.jsonc` serves `dist/` as static assets. It has no account or route yet; add both when the
site has a home, and build with `DOCS_SITE_URL` set to its origin.
