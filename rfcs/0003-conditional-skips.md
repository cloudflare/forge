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
