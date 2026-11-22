# RFC 0003: Conditional skips

Forge filters operations and fields with two extensions driven by the active
set of CLI conditions:

```yaml
x-forge-skip: true                 # always skip
x-forge-skip: [terraform]          # skip when terraform condition active
x-forge-skip: [terraform, mcp]     # skip when any listed condition active

x-forge-only-for: [sdk]            # keep only when sdk condition active
x-forge-only-for: [ts, go, rust]   # keep only when any listed condition active
```

Default (no extension): kept in every generation.

An element may carry both extensions. Exclusion wins: it is kept iff
`x-forge-only-for` matches **and** `x-forge-skip` does not.

Empty lists are no-ops; use `x-forge-skip: true` to always skip.

## Conditions

Conditions are a social contract between the spec and its consumers. Each
consumer repo pins them on the CLI:

```console
forge openapi.json --target wasm://plugin.wasm --conditions=sdk --out sdk
```

Plugins do not declare conditions; the host keeps no registry. Prefer category
names (`sdk`, `codegen`) over target-specific names (`ts-sdk-v2`), so new
siblings don't force spec edits.

The host applies these extensions before plugins see the model. A retained
element that references a skipped component fails generation.

Validation lives in `redocly-plugin-forge`.

## Vendor normalization

Forge normalizes recognized vendor extensions into the native pair as an
opt-in step via `--from`:

```console
forge openapi.json --from=stainless,fern --target wasm://plugin.wasm --out sdk
```

| Vendor extension             | Normalizes to                |
| ---------------------------- | ---------------------------- |
| `x-stainless-skip: true`     | `x-forge-skip: true`         |
| `x-stainless-skip: [names]`  | `x-forge-skip: [names]`      |
| `x-fern-audiences: [names]`  | `x-forge-only-for: [names]`  |

Consumers that don't want a vendor's extensions acted on simply omit it from
`--from`; the extensions are then left in the spec unchanged.

Native `x-forge-*` takes precedence. When both a native and a vendor
extension appear on the same element, the vendor extension is ignored.
