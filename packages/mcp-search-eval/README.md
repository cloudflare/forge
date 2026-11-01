# mcp-search-eval

How findable are the tools `forge --target mcp` generates? Each task in `tasks/` is something someone wants to do, in their words, and the methods that do it. The eval searches the generated tools for each task with BM25 over what a client sees (name, title and description) and scores where the expected tool ranked: top 1, top 5, and mean reciprocal rank.

```bash
just mcp-eval                        # the latest openapi.forge.json release
just mcp-eval path/to/spec.json      # a local spec
just mcp-eval "" --min-top5 0.8      # exit 1 below 80% in the top 5, for CI
```

Clients search tools in different ways, so this is a proxy: a drop in the score is worth a look, a single rank less so. It catches names that don't carry the words people use, such as a Worker upload named `workers_legacy_scripts_update`. Blind tests with agents (cloudflare/mcp's `bench/`) catch what a search score can't.

The search and the scoring are generic; only the tasks are Cloudflare's. Expected methods are written `METHOD /path` with the path as forge writes it, so a merged `/{account_or_zone}/{account_or_zone_id}/…` path stays merged.
