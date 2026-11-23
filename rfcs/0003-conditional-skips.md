# RFC 0003: Conditional skips

Forge filters operations and fields with two extensions driven by the active
set of CLI conditions:

```yaml
x-forge-skip: true # always skip
x-forge-skip: [terraform] # skip when terraform condition active
x-forge-skip: [terraform, mcp] # skip when any listed condition active

x-forge-only-for: [sdk] # keep only when sdk condition active
x-forge-only-for: [ts, go, rust] # keep only when any listed condition active
```

Both extensions can be placed on path items, operations (and each entry
of `x-forge-aliases`), parameters, request bodies, responses, schema
definitions, and schema properties.

Default (no extension): kept in every generation.

An element may carry both extensions. Exclusion wins: it is kept iff
`x-forge-only-for` matches **and** `x-forge-skip` does not.

Empty lists and `x-forge-skip: false` are no-ops; use `x-forge-skip: true` to
always skip. A skipped property's name is left in its schema's `required`
array verbatim; the field-building loop silently ignores required names that
match no property.

## Conditions

Conditions are a social contract between the spec and its consumers. Each
consumer repo pins them on the CLI:

```console
forge generate openapi.json --target wasm://plugin.wasm --conditions=sdk --out sdk
```

Condition names are case-sensitive, non-empty strings; order and duplicates
in a list don't affect semantics.

Plugins do not declare conditions; the host keeps no registry. Prefer
category names (`sdk`, `codegen`) over target-specific names (`ts-sdk-v2`),
so new siblings don't force spec edits.

The host applies these extensions before plugins see the model. In the
JavaScript library (`@cloudflare/forge`), `parse(json)` with no `conditions`
option leaves conditional filters as no-ops and keeps every element:
`x-forge-skip: true` still drops, but `x-forge-skip: [names]` and
`x-forge-only-for` have no effect. Pass conditions through the options
argument to filter: `parse(json, { conditions: ['sdk'] })`.

A retained element whose `$ref` points to a schema definition dropped by
`x-forge-skip` or `x-forge-only-for` is a parse error naming the dangling
reference, so a stale ref fails the build rather than silently losing a
model.

Validation lives in `redocly-plugin-forge`.

## Vendor normalization

`forge normalize` rewrites recognized vendor extensions into the native
pair in place, as a separate step before `forge generate`:

```console
forge normalize --write --from=stainless --from=fern openapi.json
forge generate openapi.json --target wasm://plugin.wasm --conditions=sdk --out sdk
```

| Vendor extension            | Normalizes to               |
| --------------------------- | --------------------------- |
| `x-stainless-skip: true`    | `x-forge-skip: true`        |
| `x-stainless-skip: [names]` | `x-forge-skip: [names]`     |
| `x-fern-ignore: true`       | `x-forge-skip: true`        |
| `x-fern-audiences: [names]` | `x-forge-only-for: [names]` |

Consumers that don't want a vendor's extensions acted on simply omit it from
`--from`; the extensions are then left in the spec unchanged.

Native `x-forge-*` takes precedence. When both a native and a vendor
extension appear on the same element, the vendor extension is ignored.
Vendor extensions from different sources on the same element each normalize
to their native form and both apply, with exclusion winning as usual.
