# RFC 0003: Conditional skips

## Summary

Forge filters skipped operations and fields before a plugin receives its model.
`x-forge-skip` accepts a boolean or one condition rule:

```yaml
x-forge-skip: true

x-forge-skip:
  when: [terraform]

x-forge-skip:
  unless: [sdk]
```

A generation has an unordered set of active condition names, such as `sdk` and
`typescript`. `when` skips when any named condition is active. `unless` skips
when none is active. The two keys are mutually exclusive.

| Value               | Result                                       |
| ------------------- | -------------------------------------------- |
| missing or `false`  | keep                                         |
| `true`              | skip                                         |
| `{ when: names }`   | skip when the active set intersects `names`  |
| `{ unless: names }` | skip when the active set misses every `name` |

Names are exact, case-sensitive strings. Their order and duplicates have no
effect. `when: []` is equivalent to `false`; `unless: []` is equivalent to
`true`.

## Conditions

The name follows Node's conditional exports: several independent conditions can
describe one output. For example, a TypeScript SDK can activate both `sdk` and
`typescript`.

The CLI accepts additional conditions as a comma-separated set:

```console
forge openapi.json --target wasm://plugin.wasm --conditions=sdk,typescript --out sdk
```

Built-in targets provide their own conditions. The host resolves skips before
building the Forge model, so plugins cannot disagree about filtering and never
receive skipped definitions or skip metadata. A future `--include-skipped`
option may bypass filtering for inspection; it is not part of this RFC.

## Compatibility adapters

The compatibility layer maps vendor intent instead of copying vendor shapes:

- `x-stainless-skip: [terraform]` becomes
  `x-forge-skip: { when: [terraform] }`.
- `x-fern-audiences: [sdk]` becomes
  `x-forge-skip: { unless: [sdk] }`.
- Boolean vendor skips remain boolean.

`x-forge-availability` remains independent lifecycle metadata and is not a
filter. This design adds no audience field to the plugin API and requires no WIT
change.
