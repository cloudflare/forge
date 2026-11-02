# RFC 0002: Versioning and downstream compatibility

## Summary

Forge has one version across its Git release, Cargo package, binary and
`@cloudflare/forge` npm package. They are released together with the same version
number.

The WIT world ships with Forge but keeps its own version. It changes only when
the interface between Forge and a plugin changes.

A change is breaking when a developer must change a spec, Rust or JavaScript
code, or plugin; rebuild a plugin; or migrate incompatible generated code.

## Version rules

`Cargo.toml` is the source of the Forge version. Between releases, the repository
keeps the last released version. Preparing a release updates `Cargo.toml`, copies
that version to the npm package, and checks that the Git tag and
`forge --version` match.

Before Forge 1.0, fixes and small compatible changes increment the patch version.
Breaking changes and significant new features, such as a new plugin, increment
the minor version. After 1.0, Forge follows normal semantic versioning.

| Change                           | Forge                  | WIT              | What developers do                         |
| -------------------------------- | ---------------------- | ---------------- | ------------------------------------------ |
| Fix or small compatible change   | Patch                  | No change        | Nothing                                    |
| Significant compatible feature   | Minor                  | No change        | Nothing                                    |
| Compatible plugin API addition   | Patch or minor         | Patch            | Existing plugins keep working              |
| Breaking plugin API change       | Minor before Forge 1.0 | Minor before 1.0 | Update and rebuild plugins                 |
| Breaking parser or output change | Minor before Forge 1.0 | No change        | Update the affected spec or generated code |

After WIT 1.0, a breaking WIT change increments its major version. A WIT change
is compatible only if a plugin built against the previous version still runs.

## What developers can rely on

- **Specs:** Removing or changing the meaning of a supported OpenAPI shape or
  extension is breaking. Before Forge stops accepting an old form, the
  `normalize` command provides the migration to the new form.
- **APIs and plugins:** The Rust crate, JavaScript API and WIT world ship in the
  same Forge release. A source-breaking change to any of them is breaking.
- **Generated code:** If a Forge change makes downstream code migrate, it is
  breaking even when the spec and plugin still compile.

## Release requirements

Every release says what changed for spec authors, plugin authors and generated
code consumers. It also states the WIT version, whether plugins must rebuild and
any migration steps.

CI must keep Cargo, npm, the Git tag and `forge --version` equal. It must also
test old plugins against compatible WIT changes and show plugin-model and
generated-output changes for review.
