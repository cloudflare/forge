# RFC 0003: Conditional skips

## Summary

Forge receives the same generation decision in two opposite vendor forms:
Stainless lists targets to skip, while Fern lists audiences to keep. Copying
either shape would make Forge's model vendor-specific and leave plugins to
interpret it. Both should normalize into one Forge-native policy so specs can
migrate away from the vendor extensions.

Forge filters skipped operations and fields before a plugin receives its model.
`x-forge-skip` accepts a boolean or a condition rule:

```yaml
x-forge-skip: true

x-forge-skip:
  when: [terraform]

x-forge-skip:
  unless: [sdk]

x-forge-skip:
  when: [terraform]
  unless: [sdk]
```

A generation has an unordered set of active condition names, such as `sdk` and
`typescript`. `when` skips when any named condition is active. `unless` skips
when none is active. A condition rule contains at least one of the two keys and
may contain both. When both are present, the element is skipped if `when`
matches **or** `unless` does not match, so exclusion wins.

| Value                    | Result                                                      |
| ------------------------ | ----------------------------------------------------------- |
| missing or `false`       | keep                                                        |
| `true`                   | skip                                                        |
| `{ when: names }`        | skip when the active set intersects `names`                 |
| `{ unless: names }`      | skip when the active set misses every `name`                |
| `{ when: a, unless: b }` | skip when the active set intersects `a` or misses every `b` |

Each supplied list contains at least one condition. Names are non-empty, exact,
case-sensitive strings. Their order and duplicates have no effect. An empty
rule or list is invalid rather than an implicit always or never rule; use a
boolean for those cases.

## Conditions

Several independent conditions can describe one output. For example, a
TypeScript SDK can activate both `sdk` and `typescript`.

The CLI accepts additional conditions as a comma-separated set:

```console
forge openapi.json --target wasm://plugin.wasm --conditions=sdk,typescript --out sdk
```

Built-in targets provide their own conditions. A custom plugin starts with no
active conditions unless the CLI supplies them. With no active conditions,
`when` never skips and `unless` always skips.

The host resolves skips before building the Forge model, so plugins cannot
disagree about filtering and never receive skipped definitions or skip
metadata.

After filtering, the host validates the resulting document. Straightforward
local bookkeeping is repaired, such as removing a skipped property from its
schema's `required` list. If a retained element references a skipped component,
generation fails with a diagnostic identifying both the reference and the
skipped target. Forge neither cascades the skip to the referencing element nor
retains the skipped dependency.

## Compatibility adapters

The compatibility layer maps vendor intent instead of copying vendor shapes:

- `x-stainless-skip: [terraform]` becomes
  `x-forge-skip: { when: [terraform] }`.
- `x-fern-audiences: [sdk]` becomes
  `x-forge-skip: { unless: [sdk] }`.
- Boolean vendor skips remain boolean.

An explicit `x-forge-skip`, including `false`, is authoritative. When it is
present, Forge ignores compatibility extensions on the same element. When it is
absent, normalization combines recognized compatibility inputs into one native
rule: target skips contribute `when`, audiences contribute `unless`, and names
for the same key are unioned. A boolean `true` dominates and becomes an
unconditional skip; `false` contributes nothing.

`x-forge-availability` remains independent lifecycle metadata and is not a
filter. This design adds no audience field to the plugin API and requires no WIT
change.
