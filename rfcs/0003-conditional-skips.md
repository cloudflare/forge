# RFC 0003: Conditional skips

Forge normalizes Stainless's "skip targets" and Fern's "keep audiences" into
one extension, `x-forge-skip`:

```yaml
x-forge-skip: true                                  # always skip
x-forge-skip: { when: [terraform] }                 # skip when terraform active
x-forge-skip: { unless: [sdk] }                     # skip unless sdk active
x-forge-skip: { when: [terraform], unless: [sdk] } # both; exclusion wins
```

- `when`: skip if the active condition set intersects the list.
- `unless`: skip if the active set misses every entry.
- Both: skip if either rule matches.
- Missing or `false`: keep. `true`: always skip. Empty lists: no-op.

## Conditions

Conditions are a social contract between the spec and its consumers. Each
consumer repo pins them on the CLI:

```console
forge openapi.json --target wasm://plugin.wasm --conditions=sdk --out sdk
```

Plugins do not declare conditions; the host keeps no registry. Prefer category
names (`sdk`, `codegen`) over target-specific names (`ts-sdk-v2`), so new
siblings don't force spec edits.

The host resolves skips before plugins see the model. A retained element that
references a skipped component fails generation.

## Vendor compatibility

- `x-stainless-skip: [terraform]` → `x-forge-skip: { when: [terraform] }`
- `x-fern-audiences: [sdk]` → `x-forge-skip: { unless: [sdk] }`
- Boolean vendor skips stay boolean.

An explicit `x-forge-skip` is authoritative. Validation lives in
`redocly-plugin-forge`.
