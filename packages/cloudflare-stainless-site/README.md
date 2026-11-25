# cloudflare-stainless-site

Generates two files in `cloudflare-api-site` from the retired Stainless API
reference:

- `src/stainless-redirects.json`: the old site's pages, which the site redirects
  to today's;
- `src/stainless-snippets.json`: its TypeScript, Python and Go samples.

Temporary: delete it once Forge generates SDK samples and the redirects are
retired.

## Usage

The source is private, so run it locally with a GitLab token that can read the
Stainless docs site's project. From the repository root, generate the redirects
first, because the snippets generator only keeps the pages the redirects hold:

```sh
GITLAB_TOKEN=<token> pnpm generate:stainless-redirects \
  --gitlab-url https://<gitlab host> --project <group>/<project>
GITLAB_TOKEN=<token> pnpm generate:stainless-snippets \
  --gitlab-url https://<gitlab host> --project <group>/<project>
```

The redirects generator prints what changed against the committed file. Add
`--verbose` to list the changes, and review them before committing. Neither
generator writes the GitLab host into its output.
