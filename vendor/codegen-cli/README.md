# Vendored Fern fork

Cloudflare's fork of [Fern](https://github.com/fern-api/fern) (Apache-2.0),
packaged as two npm tarballs built from the `fern` branch of
<https://github.com/cloudflare/forge>. That branch starts from a snapshot of
fern-api/fern at the 5.112.0 release (`8bfa8e27e691eb29a3bd7053942780ba0ea6466d`),
keeps its `LICENSE`, and carries Cloudflare's patches on top. The tarballs are
checked in here so generation does not download Fern from npm or Docker Hub.

| Tarball                                        | Package                                                             | Upstream                                                  | Version   | Built from                                 |
| ---------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------- | --------- | ------------------------------------------ |
| `fern-api-5.112.0.tgz`                         | `fern-api` (the `fern` command)                                     | Fern CLI (`fern-api` on npm)                              | `5.112.0` | `2e7e57b4de410ae400e80ff8f4809c77eba50930` |
| `cloudflare-codegen-typescript-sdk-3.88.3.tgz` | `@cloudflare/codegen-typescript-sdk` (the TypeScript SDK generator) | Fern TypeScript generator (`fernapi/fern-typescript-sdk`) | `3.88.3`  | `1d1bde1820d5fc17f6a1c8c91cdf657e13956836` |

The commit is also the `gitHead` field in each tarball's `package.json`.
Versions are the upstream releases the fork is built on. The CLI keeps
upstream's package name, `fern-api`, but never contacts npm: it skips upgrade
checks, and it fails when `version` in `fern.config.json` does not match
instead of downloading another build.

Fern's TypeScript generator runs natively (no Docker): `generators.yml` points
`local-command` at its `cli.cjs`, and the CLI runs it on the host. It shells
out to `oxfmt` and `oxlint`, which must be on `PATH`; otherwise it installs
them into the output project on every run.

`@cloudflare/forge-transformer-sdk-ts` lists both tarballs as devDependencies
and its build copies them into `dist/vendor/`. The packed transformer therefore
carries the CLI and the generator itself and has no `file:` dependency on this
directory, so repos that vendor the transformer tarball need no change.

## Updating

```bash
# in a checkout of the fern branch
scripts/build-vendor-cli.sh /path/to/this/repo/vendor/codegen-cli
scripts/build-vendor-typescript-generator.sh /path/to/this/repo/vendor/codegen-cli
# then in this repo
pnpm install
```

Update the commits above in the same change.
