# Forge

Forge is a schema-first OpenAPI code generation and surface tooling framework. It provides a plugin-based architecture for resolving OpenAPI 3.x specifications, applying JSONPath-based overlays, and generating typed SDKs, CLI interfaces, runtime helpers, and documentation.

It's [still early-days](https://blog.cloudflare.com/forge-open-source-generation-pipeline) for Forge and we're laser focused on the first Forge output, the [cf CLI](https://blog.cloudflare.com/cloudflare-cf-cli-launch). Rest assured, in short order we'll be making it easier and easier for other targets (namely, TypeScript, Go, Python, Terraform, etc. - and docs for all of the above), but that will track in parallel to us releasing those targets for our own SDKs. That's just how we do things at Cloudflare: we often open source as soon as we can (often, sooner than others might) and always test our products on ourselves first.

## Documentation

The guides and reference for Forge, its model and its plugins are in the
[Forge documentation source](https://github.com/cloudflare/forge/tree/main/packages/docs/src/content/docs).
Start with [About Forge](https://github.com/cloudflare/forge/blob/main/packages/docs/src/content/docs/start/about.mdx)
and [Get started](https://github.com/cloudflare/forge/blob/main/packages/docs/src/content/docs/start/get-started.mdx).

## Rust library

Forge's Rust package is named `cloudflare-forge`. Registry publishing is currently paused. Depend
on the repository and rename the package to `forge` so Rust code imports its API through `forge::`:

```toml
[dependencies.forge]
package = "cloudflare-forge"
git = "https://github.com/cloudflare/forge"
default-features = false
```

The default `cli` feature also builds the `forge` command. Enable `wasm` to run WebAssembly plugins
from a Rust host. The [Rust API reference](https://github.com/cloudflare/forge/blob/main/packages/docs/src/content/docs/reference/rust-api.mdx)
lists the public model and plugin interfaces.

## License

Apache-2.0 © Cloudflare, Inc.
