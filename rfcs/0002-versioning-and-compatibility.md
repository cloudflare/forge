# RFC 0002: Versioning and downstream compatibility

## Summary

Forge has one version across its Git release, Cargo package, binary and
`@cloudflare/forge` npm package. They are released together with the same version
number.

The WIT world ships with Forge but keeps its own version. It changes only when
the interface between Forge and a plugin changes.

A change is breaking when a developer must change a spec or plugin, rebuild a
plugin, or migrate incompatible generated code.

## Version rules

`Cargo.toml` is the source of the Forge version. The release process copies it to
the npm package and checks that the Git tag and `forge --version` match.

Before Forge 1.0, compatible changes increment the patch version and breaking
changes increment the minor version. After 1.0, Forge follows normal semantic
versioning.

| Change                           | Forge            | WIT              | What developers do                         |
| -------------------------------- | ---------------- | ---------------- | ------------------------------------------ |
| Fix or internal change           | Patch            | No change        | Nothing                                    |
| Compatible plugin API addition   | Patch            | Patch            | Existing plugins keep working              |
| Breaking plugin API change       | Minor before 1.0 | Minor before 1.0 | Update and rebuild plugins                 |
| Breaking parser or output change | Minor before 1.0 | No change        | Update the affected spec or generated code |

After WIT 1.0, a breaking WIT change increments its major version. A WIT change
is compatible only if a plugin built against the previous version still runs.

## What developers can rely on

- **Specs:** A spec that Forge accepts keeps working with the same meaning.
  Removing a supported OpenAPI shape or extension is breaking. Extension renames
  first accept both names and give developers time to migrate.
- **Plugins:** Rust, JavaScript and WIT expose the same model in the same Forge
  release. A breaking change to any of them is a breaking plugin API change.
- **Generated code:** If a Forge change makes downstream code migrate, it is
  breaking even when the spec and plugin still compile.

## How cf uses Forge

The cf repository pins an exact `@cloudflare/forge` package. The package contains
the matching Forge binary, JavaScript API and WIT world. During generation, cf:

1. builds its generator plugin against that package;
2. runs that package's Forge binary with the plugin;
3. commits the generated TypeScript to the cf repository.

cf separately pins `openapi.forge.json` by Git SHA. The two pins have different
jobs:

- the Forge version selects the parser, model and plugin API;
- the OpenAPI SHA selects the Cloudflare API snapshot to generate from.

Updating to a breaking Forge version includes updating and rebuilding cf's
plugin. Updating only the OpenAPI SHA does not change Forge or WIT.

## Release requirements

Every release says what changed for spec authors, plugin authors and generated
code consumers. It also states the WIT version, whether plugins must rebuild and
any migration steps.

CI must keep Cargo, npm, the Git tag and `forge --version` equal. It must also
test old plugins against compatible WIT changes and show plugin-model and
generated-output changes for review.
