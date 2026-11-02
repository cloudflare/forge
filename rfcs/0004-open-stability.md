# RFC 0004: Open stability stages

## Summary

Fern describes API maturity with `x-fern-availability`; existing specs also use
`x-stability`. Their vocabularies overlap but are not complete: stages such as a
release candidate do not fit Forge's current closed availability enum.

Forge replaces that enum with the native extension `x-forge-stability`. Its
value resolves to an open enum:

```yaml
x-forge-stability: release-candidate
```

```text
alpha
beta
preview
release-candidate
stable
deprecated
other(string)
```

Known values let plugins handle common stages exhaustively. Any other nonempty
string becomes `other` with its original value, so new vocabulary does not
require a Forge or plugin-interface change. Stages have no ordering and do not
filter the model.

## Classes

Known stages have one of three broad meanings:

| Class         | Stages                                          |
| ------------- | ----------------------------------------------- |
| `pre-release` | `alpha`, `beta`, `preview`, `release-candidate` |
| `stable`      | `stable`                                        |
| `deprecated`  | `deprecated`                                    |

`other` is unclassified. The Rust and TypeScript APIs expose a derived
classifier that returns one of these classes or none for `other`; three boolean
helpers would incorrectly make an unknown stage look definitively neither
pre-release, stable nor deprecated. Classification is descriptive and does not
filter the model.

The escape hatch is intentional. APIs may use stages such as `experimental`,
`early-access`, `canary`, `maintenance`, `legacy`, `sunset`, `retired` or
`end-of-life`. Forge preserves these without assigning semantics until a real
consumer needs them. In particular, `deprecated` normally remains usable while
`retired` may not, so Forge should not classify them together prematurely.
Labels such as `internal`, `private` and `invite-only` describe visibility and
belong in conditions rather than stability.

## Resolution

Forge recognizes these exact, case-sensitive aliases:

| Written value          | Resolved stage      |
| ---------------------- | ------------------- |
| `rc`                   | `release-candidate` |
| `release-candidate`    | `release-candidate` |
| `ga`                   | `stable`            |
| `generally-available`  | `stable`            |
| `stable`               | `stable`            |
| another nonempty value | `other(value)`      |

`deprecated` is a stability stage, not a second source of truth. OpenAPI
`deprecated: true` resolves to that stage where the field exists;
`x-forge-stability: deprecated` works on every Forge entity that supports
stability metadata. Writing `deprecated: true` with a different stability is an
error. APIs may keep an `is_deprecated` convenience derived from the resolved
stage.

## Compatibility

- `x-forge-stability` wins over compatibility sources.
- `x-forge-availability` remains a deprecated native alias.
- `x-fern-availability` maps through the aliases above.
- `x-stability` maps through the same resolver.

The Rust, TypeScript and WIT plugin APIs replace `availability` with
`stability`. WIT represents the open enum as known cases plus `other(string)`;
this breaking interface change increments the pre-1.0 WIT minor version and
requires plugins to rebuild.

Dates, versions, transition history and configurable stage classifications are
future lifecycle metadata and are outside this RFC.
